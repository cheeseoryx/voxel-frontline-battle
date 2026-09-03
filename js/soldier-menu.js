/**
 * soldier-menu.js — Soldier profile, equipment archive and vehicle catalog.
 */
(function (global) {
  'use strict';

  const NAV = [
    { id: 'home', label: '主页', icon: '⌂' },
    { id: 'stats', label: '数据', icon: '◉' },
    { id: 'achievements', label: '成就', icon: '♟' },
    { id: 'weapons', label: '武器', icon: '⚑', group: true },
    { id: 'weapon-assault', label: '突击步枪', child: true },
    { id: 'weapon-carbine', label: '卡宾枪', child: true },
    { id: 'weapon-smg', label: '冲锋枪', child: true },
    { id: 'weapon-battle', label: '战斗步枪', child: true },
    { id: 'weapon-lmg', label: '轻机枪', child: true },
    { id: 'weapon-dmr', label: '精确射手步枪', child: true },
    { id: 'weapon-sniper', label: '狙击步枪', child: true },
    { id: 'weapon-shotgun', label: '霰弹枪', child: true },
    { id: 'weapon-pistol', label: '手枪', child: true },
    { id: 'gadgets', label: '装备', icon: '◒', group: true },
    { id: 'gadget-medical', label: '急救包', child: true },
    { id: 'gadget-light', label: '轻型装备', child: true },
    { id: 'gadget-heavy', label: '重型装备', child: true },
    { id: 'gadget-throwable', label: '投掷物', child: true },
    { id: 'vehicles', label: '载具', icon: '▰', group: true },
    { id: 'vehicle-transport', label: '运输载具', child: true },
    { id: 'vehicle-ground', label: '地面载具', child: true },
    { id: 'vehicle-light', label: '轻型装甲载具', child: true },
    { id: 'vehicle-tank', label: '主战坦克', child: true },
    { id: 'vehicle-naval', label: '海军舰艇', child: true },
    { id: 'vehicle-heli', label: '直升机', child: true },
  ];

  const WEAPON_CATEGORY = {
    assault: '突击步枪',
    carbine: '卡宾枪',
    smg: '冲锋枪',
    battle: '战斗步枪',
    lmg: '轻机枪',
    dmr: '精确射手步枪',
    sniper: '狙击步枪',
    shotgun: '霰弹枪',
    pistol: '手枪',
  };

  const WEAPON_CATALOG = [
    { name: 'AKM', category: 'assault', silhouette: 'rifle', rank: 0, gameId: 'ar' },
    { name: 'ACR', category: 'assault', silhouette: 'rifle-modern', rank: 110, gameId: 'acr' },
    { name: 'AK-74', category: 'assault', silhouette: 'rifle', rank: 0, gameId: 'ak74' },
    { name: 'AUG A3', category: 'assault', silhouette: 'bullpup', rank: 75, gameId: 'auga3' },
    { name: 'FAMAS', category: 'assault', silhouette: 'bullpup-compact', rank: 95, gameId: 'famas' },
    { name: 'SG550', category: 'assault', silhouette: 'rifle-long', rank: 80, gameId: 'sg550' },
    { name: 'F2000', category: 'assault', silhouette: 'bullpup-heavy', rank: 35, gameId: 'f2000' },
    {
      name: 'AK15',
      category: 'assault',
      also: ['battle'],
      silhouette: 'ak15',
      rank: 15,
      gameId: 'ak15',
    },
    {
      name: 'SCAR-H',
      category: 'assault',
      also: ['battle'],
      silhouette: 'scar-h',
      rank: 50,
      gameId: 'scarh',
    },
    { name: 'FAL', category: 'assault', also: ['battle'], silhouette: 'fal', rank: 140, gameId: 'fal' },
    { name: 'G3', category: 'assault', also: ['battle'], silhouette: 'g3', rank: 90, gameId: 'g3' },

    { name: 'G36C', category: 'carbine', silhouette: 'carbine', rank: 120, gameId: 'g36c' },
    { name: 'M4A1', category: 'carbine', silhouette: 'carbine-stock', rank: 0, gameId: 'm4a1' },
    { name: 'AS VAL', category: 'carbine', silhouette: 'suppressed', rank: 105, gameId: 'asval' },
    { name: 'GROZA', category: 'carbine', silhouette: 'bullpup-compact', rank: 55, gameId: 'groza' },
    { name: 'HK419', category: 'carbine', silhouette: 'carbine', rank: 135, gameId: 'hk419' },
    { name: 'AK5C', category: 'carbine', silhouette: 'carbine-stock', rank: 145, gameId: 'ak5c' },

    { name: 'HONEY BADGER', category: 'smg', silhouette: 'suppressed-compact', rank: 65, gameId: 'honeybadger' },
    { name: 'MP7', category: 'smg', silhouette: 'smg-compact', rank: 0, gameId: 'mp7' },
    { name: 'PP2000', category: 'smg', silhouette: 'smg-wire', rank: 25, gameId: 'pp2000' },
    { name: 'P90', category: 'smg', silhouette: 'p90', rank: 125, gameId: 'p90' },
    { name: 'KRISS VECTOR', category: 'smg', silhouette: 'vector', rank: 70, gameId: 'vector' },
    { name: 'UMP-45', category: 'smg', silhouette: 'smg-stock', rank: 0, gameId: 'ump45' },
    { name: 'MP5', category: 'smg', silhouette: 'smg-stock', rank: 90, gameId: 'mp5' },
    { name: 'PP-19', category: 'smg', silhouette: 'smg-drum', rank: 45, gameId: 'pp19' },
    { name: 'SCORPION EVO', category: 'smg', silhouette: 'smg-modern', rank: 150, gameId: 'scorpionevo' },

    { name: 'L86A1', category: 'lmg', silhouette: 'lmg-bullpup', rank: 0, gameId: 'l86a1' },
    { name: 'MG36', category: 'lmg', silhouette: 'lmg-box', rank: 50, gameId: 'mg36' },
    { name: 'RPK16', category: 'lmg', silhouette: 'lmg-rifle', rank: 35, gameId: 'rpk16' },
    { name: 'M249', category: 'lmg', silhouette: 'lmg-belt', rank: 20, gameId: 'm249' },
    { name: 'ULTIMAX 100', category: 'lmg', silhouette: 'lmg-drum', rank: 120, gameId: 'ultimax100' },

    { name: 'M110', category: 'dmr', silhouette: 'dmr', rank: 40, gameId: 'm110' },
    { name: 'MK14 EBR', category: 'dmr', silhouette: 'dmr-long', rank: 60, gameId: 'mk14ebr' },
    { name: 'MK20', category: 'dmr', silhouette: 'dmr-modern', rank: 10, gameId: 'mk20' },
    { name: 'SVD', category: 'dmr', silhouette: 'dmr-svd', rank: 0, gameId: 'sr' },

    { name: 'L96', category: 'sniper', silhouette: 'sniper', rank: 65, gameId: 'l96' },
    { name: 'SSG 69', category: 'sniper', silhouette: 'sniper-classic', rank: 0, gameId: 'ssg69' },
    { name: 'SV-98', category: 'sniper', silhouette: 'sniper', rank: 30, gameId: 'sv98' },
    { name: 'M200', category: 'sniper', silhouette: 'sniper-heavy', rank: 100, gameId: 'm200' },
    { name: 'MSR', category: 'sniper', silhouette: 'sniper-modern', rank: 130, gameId: 'msr' },
    { name: 'REM 700', category: 'sniper', silhouette: 'sniper-classic', rank: 85, gameId: 'rem700' },

    {
      name: 'Remington 870',
      category: 'shotgun',
      silhouette: 'shotgun',
      rank: 0,
      gameId: 'sg',
    },
    { name: 'M1014', category: 'shotgun', silhouette: 'shotgun', rank: 80 },
    { name: 'KS-23', category: 'shotgun', silhouette: 'shotgun', rank: 110 },
    { name: 'SAIGA-12', category: 'shotgun', silhouette: 'smg-drum', rank: 135 },

    { name: 'M9', category: 'pistol', silhouette: 'pistol', rank: 0, gameId: 'm9' },
    { name: 'USP', category: 'pistol', silhouette: 'pistol', rank: 60, gameId: 'usp' },
    { name: 'MP 443', category: 'pistol', silhouette: 'pistol-compact', rank: 0, gameId: 'mp443' },
    { name: 'GLOCK 18', category: 'pistol', silhouette: 'machine-pistol', rank: 80, gameId: 'glock18' },
    { name: 'UNICA', category: 'pistol', silhouette: 'revolver', rank: 40, gameId: 'unica' },
    { name: 'DESERT EAGLE', category: 'pistol', silhouette: 'pistol-heavy', rank: 120, gameId: 'deserteagle' },
    { name: 'RSH-12', category: 'pistol', silhouette: 'revolver-heavy', rank: 120, gameId: 'rsh12' },
  ];

  const GADGET_CATEGORY = {
    medical: '急救包',
    light: '轻型装备',
    heavy: '重型装备',
    throwable: '投掷物',
  };

  const GADGET_CATALOG = [
    {
      name: '绷带',
      category: 'medical',
      silhouette: 'bandage',
      rank: 0,
      detail: '止血并恢复少量生命值',
    },

    {
      name: '双筒望远镜',
      category: 'light',
      silhouette: 'binoculars',
      rank: 0,
      detail: '观察并标记远距离目标',
    },
    {
      name: '测距仪',
      category: 'light',
      silhouette: 'rangefinder',
      rank: 0,
      detail: '测量目标距离并辅助弹道判断',
    },
    {
      name: 'C4 炸药',
      category: 'light',
      silhouette: 'explosive',
      rank: 5,
      detail: '遥控引爆，用于破坏工事',
      gameId: 'charge',
    },
    {
      name: '阔剑定向地雷',
      category: 'light',
      silhouette: 'claymore',
      rank: 5,
      detail: '触发后向正面喷射破片',
    },
    {
      name: 'M320 烟雾榴弹发射器',
      category: 'light',
      silhouette: 'launcher',
      rank: 5,
      detail: '向远处快速投送烟雾弹',
    },
    {
      name: '反步兵地雷',
      category: 'light',
      silhouette: 'round-mine',
      rank: 0,
      detail: '感应附近步兵后爆炸',
    },
    {
      name: '反载具地雷',
      category: 'light',
      silhouette: 'round-mine',
      rank: 15,
      detail: '对重型目标造成高额爆炸伤害',
    },
    {
      name: '高级双筒望远镜',
      category: 'light',
      silhouette: 'binoculars-advanced',
      rank: 7,
      detail: '提供更高倍率的战场观察能力',
    },
    {
      name: '激光目标指示双筒镜',
      category: 'light',
      silhouette: 'soflam',
      rank: 0,
      detail: '持续照射并指示远距离目标',
    },
    {
      name: '自爆式 C4 炸药',
      category: 'light',
      silhouette: 'explosive-vest',
      rank: 5,
      detail: '高风险近距离爆破装置',
    },
    {
      name: '主动防御拦截器',
      category: 'light',
      silhouette: 'trophy',
      rank: 0,
      detail: '拦截附近来袭的爆炸投射物',
    },
    {
      name: '部署信标',
      category: 'light',
      silhouette: 'beacon',
      rank: 0,
      detail: '为小队提供前沿部署位置',
      gameId: 'beacon',
    },

    {
      name: '小型弹药包',
      category: 'heavy',
      silhouette: 'ammo-small',
      rank: 0,
      detail: '快速补充少量弹药',
    },
    {
      name: '医疗包',
      category: 'heavy',
      silhouette: 'medkit',
      rank: 0,
      detail: '持续治疗附近友军',
    },
    {
      name: 'RPG-7 破甲火箭筒',
      category: 'heavy',
      silhouette: 'rpg',
      rank: 0,
      detail: '发射高爆反装甲火箭弹',
    },
    {
      name: '防暴盾牌',
      category: 'heavy',
      silhouette: 'shield',
      rank: 100,
      detail: '抵挡正面轻武器射击',
    },
    {
      name: '破拆大锤',
      category: 'heavy',
      silhouette: 'sledgehammer',
      rank: 0,
      detail: '近距离破坏墙体与掩体',
    },
    {
      name: 'MDX-201 运动传感器',
      category: 'heavy',
      silhouette: 'sensor-tripod',
      rank: 0,
      detail: '侦测并标记附近移动目标',
      gameId: 'sensor',
    },
    {
      name: '重型弹药箱',
      category: 'heavy',
      silhouette: 'ammo-heavy',
      rank: 0,
      detail: '持续为附近友军补充生命与弹药',
      gameId: 'supply',
    },
    {
      name: '抓钩发射器',
      category: 'heavy',
      silhouette: 'grappling-hook',
      rank: 25,
      detail: '在高处建立可攀爬绳索',
    },
    {
      name: '空中侦察无人机',
      category: 'heavy',
      silhouette: 'drone',
      rank: 0,
      detail: '从空中侦察并标记敌军',
    },
    {
      name: '破拆镐',
      category: 'heavy',
      silhouette: 'pickaxe',
      rank: 0,
      detail: '开凿地形和轻型工事',
    },

    {
      name: '破片手榴弹',
      category: 'throwable',
      silhouette: 'frag-grenade',
      rank: 0,
      detail: '延时爆炸并造成范围破片伤害',
    },
    {
      name: '冲击手榴弹',
      category: 'throwable',
      silhouette: 'impact-grenade',
      rank: 35,
      detail: '碰撞后立即引爆',
    },
    {
      name: '反载具手榴弹',
      category: 'throwable',
      silhouette: 'anti-vehicle-grenade',
      rank: 0,
      detail: '对重型目标造成额外伤害',
    },
    {
      name: '蓝色烟雾弹',
      category: 'throwable',
      silhouette: 'smoke-grenade',
      rank: 0,
      detail: '释放蓝色烟雾以标识区域',
    },
    {
      name: '绿色烟雾弹',
      category: 'throwable',
      silhouette: 'smoke-grenade',
      rank: 0,
      detail: '释放绿色烟雾以标识区域',
    },
    {
      name: '红色烟雾弹',
      category: 'throwable',
      silhouette: 'smoke-grenade',
      rank: 0,
      detail: '释放红色烟雾以标识区域',
    },
    {
      name: '白色烟雾弹',
      category: 'throwable',
      silhouette: 'smoke-grenade',
      rank: 0,
      detail: '遮断视线并掩护小队推进',
      gameId: 'smoke',
    },
    {
      name: '照明棒',
      category: 'throwable',
      silhouette: 'flare',
      rank: 0,
      detail: '照亮暗处并标记位置',
    },
    {
      name: '闪光弹',
      category: 'throwable',
      silhouette: 'flashbang',
      rank: 55,
      detail: '短暂致盲并干扰附近敌军',
    },
  ];

  const VEHICLES = {
    transport: [
      {
        name: '军用吉普',
        silhouette: 'jeep',
        available: true,
        detail: '6 座轻型装甲运输载具 · 无车载武器',
      },
      { name: '通用运输车', silhouette: 'utility' },
      { name: '装甲运兵车', silhouette: 'carrier' },
      { name: '重型运输车', silhouette: 'truck' },
      { name: '战术越野车', silhouette: 'buggy' },
      { name: '敞篷运输车', silhouette: 'open-jeep' },
      { name: '四轮摩托', silhouette: 'quad' },
      { name: '前线指挥车', silhouette: 'command' },
    ],
    ground: [
      { name: '战术卡车', silhouette: 'truck' },
      { name: '工程保障车', silhouette: 'engineering' },
      { name: '防空平台', silhouette: 'aa' },
      { name: '火力支援车', silhouette: 'support' },
    ],
    light: [
      { name: '轻型装甲平台', silhouette: 'light-armor' },
      {
        name: '步兵战车',
        silhouette: 'ifv',
        available: true,
        detail: '6 座轻型装甲 · HE 自动炮 / 反装甲导弹 / 炮手榴弹发射器',
      },
    ],
    tank: [
      {
        name: '主战坦克',
        silhouette: 'tank-a',
        available: true,
        detail: '2 座 · 血量 1000 · 主炮 / 同轴机枪 / 炮手重机枪',
      },
      { name: '主战坦克 B', silhouette: 'tank-b' },
    ],
    naval: [
      { name: '近岸巡逻艇', silhouette: 'patrol-boat' },
      { name: '装甲突击艇', silhouette: 'assault-boat' },
      { name: '高速拦截艇', silhouette: 'interceptor' },
    ],
    heli: [
      { name: '轻型侦察直升机', silhouette: 'scout-heli' },
      { name: '通用直升机', silhouette: 'utility-heli' },
      { name: '战术运输直升机', silhouette: 'transport-heli' },
      { name: '武装侦察直升机', silhouette: 'armed-heli' },
      { name: '攻击直升机', silhouette: 'attack-heli' },
      { name: '重型运输直升机', silhouette: 'heavy-heli' },
    ],
  };

  const WEAPON_SILHOUETTES = {
    rifle:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M22 27h77v20H22z"/><path d="M99 31h57v7H99z"/><path d="M12 25h22v9H12z"/><path d="M29 46h15l-8 17H24z"/><path d="M65 45h14l8 18H73z"/><path d="M48 47h12v15H48z"/></svg>',
    'rifle-modern':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M28 24h76l13 21H28z"/><path d="M105 29h52v7h-48z"/><path d="M10 29l24-10v17H10z"/><path d="M48 45h14v17H48z"/><path d="M74 44h15l9 19H83z"/><path d="M50 18h40v7H50z"/></svg>',
    ak15:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M36 25h71l12 19H36z"/><path d="M106 29h52v7h-52zM156 27h15v11h-15z"/><path d="M12 20h13l15 9v12L25 36H10z"/><path d="M53 43h14v20H53zM81 43h17l-2 8-9 12h-9z"/><path d="M48 17h49v8H48zM70 12h20v6H70z"/></svg>',
    'scar-h':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M39 23h70l13 22H37z"/><path d="M108 28h50v8h-50zM157 26h14v12h-14z"/><path d="M12 20h22l7 8v13H27l-7-7H10z"/><path d="M53 44h14v19H53zM81 43h17l5 20H89z"/><path d="M49 16h51v8H49zM61 11h30v6H61z"/></svg>',
    fal:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M34 26h79v18H34z"/><path d="M112 29h54v7h-54zM164 27h10v11h-10z"/><path d="M9 24h27v10H9zM16 34h20v9H16z"/><path d="M51 43h14v20H51zM81 43h15l7 20H91z"/><path d="M48 19h57v7H48zM72 14h25v6H72z"/></svg>',
    g3:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M38 25h72v20H38z"/><path d="M109 29h54v7h-54zM161 27h12v11h-12z"/><path d="M11 23h28v12H11zM20 35h19v8H20z"/><path d="M53 44h14v19H53zM83 44h14l7 19H92z"/><path d="M51 18h50v8H51zM66 13h27v6H66z"/></svg>',
    bullpup:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M18 25h92l17 23H34L18 39z"/><path d="M110 30h49v6h-45z"/><path d="M73 46h16l7 17H81z"/><path d="M31 44h15v16H31z"/><path d="M49 18h39v8H49z"/></svg>',
    'bullpup-compact':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M25 24h82l15 22H38L21 36z"/><path d="M107 28h45v7h-40z"/><path d="M73 44h16l7 18H81z"/><path d="M33 42h13v17H33z"/><path d="M55 17h37v8H55z"/></svg>',
    'bullpup-heavy':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M18 24h96l18 24H30L14 36z"/><path d="M115 30h43v7h-40z"/><path d="M77 46h18l8 17H87z"/><path d="M30 44h17v17H30z"/><path d="M43 17h53v8H43z"/></svg>',
    carbine:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M34 25h71v21H34z"/><path d="M104 30h48v7h-48z"/><path d="M12 24h24v8H12z"/><path d="M18 32h19v7H18z"/><path d="M53 45h13v18H53z"/><path d="M77 45h14l7 18H85z"/><path d="M54 18h38v7H54z"/></svg>',
    'carbine-stock':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M37 25h68v21H37z"/><path d="M105 30h48v7h-48z"/><path d="M11 20h8v19h-8z"/><path d="M18 26h21v7H18z"/><path d="M55 45h13v18H55z"/><path d="M78 45h14l8 18H87z"/><path d="M57 18h36v7H57z"/></svg>',
    suppressed:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M31 25h72v21H31z"/><path d="M102 30h35v7h-35z"/><path d="M136 27h34v12h-34z"/><path d="M10 23h23v9H10z"/><path d="M51 45h13v18H51z"/><path d="M77 45h13l8 18H86z"/></svg>',
    'suppressed-compact':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M37 26h68v20H37z"/><path d="M104 31h27v6h-27z"/><path d="M130 28h34v12h-34z"/><path d="M15 25h23v8H15z"/><path d="M57 45h13v18H57z"/><path d="M82 45h13l6 18H91z"/></svg>',
    'smg-compact':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M43 27h67v20H43z"/><path d="M109 31h35v7h-35z"/><path d="M20 25h24v8H20z"/><path d="M58 46h13v17H58z"/><path d="M87 45h12l6 18H95z"/></svg>',
    'smg-wire':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M48 27h62v20H48z"/><path d="M109 31h34v7h-34z"/><path d="M15 24h34v4H19v19h-4z"/><path d="M63 46h13v17H63z"/><path d="M88 45h12l6 18H96z"/></svg>',
    p90:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M25 24h102l18 14-19 14H38L20 41z"/><path d="M50 18h66v7H50z"/><circle cx="106" cy="38" r="8" fill="var(--vehicle-cut)"/><path d="M65 49h16v14H65z"/></svg>',
    vector:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M43 24h69v18H43z"/><path d="M111 29h39v7h-39z"/><path d="M18 23h26v8H18z"/><path d="M57 41h20l-7 22H56z"/><path d="M88 41h13l8 22H98z"/></svg>',
    'smg-stock':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M42 26h68v20H42z"/><path d="M109 31h38v7h-38z"/><path d="M13 24h30v9H13z"/><path d="M58 45h13v18H58z"/><path d="M85 45h13l7 18H94z"/></svg>',
    'smg-drum':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M38 26h73v20H38z"/><path d="M110 31h39v7h-39z"/><path d="M14 24h26v9H14z"/><path d="M54 45h13v18H54z"/><circle cx="89" cy="52" r="12"/></svg>',
    'smg-modern':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M39 24h73l10 22H39z"/><path d="M116 30h36v7h-34z"/><path d="M13 25h27v8H13z"/><path d="M57 45h13v18H57z"/><path d="M87 44h14l8 19H97z"/><path d="M58 17h43v8H58z"/></svg>',
    lmg:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M24 24h92v23H24z"/><path d="M115 29h51v8h-51z"/><path d="M8 23h18v10H8z"/><path d="M48 46h14v17H48z"/><path d="M84 45h18v17H84z"/><path d="M60 17h43v8H60z"/></svg>',
    dmr:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M24 27h79v19H24z"/><path d="M102 31h64v6h-64z"/><path d="M8 25h18v9H8z"/><path d="M46 45h14v17H46z"/><path d="M78 45h13l8 18H87z"/><path d="M53 16h50v6H53z"/><path d="M65 12h25v5H65z"/></svg>',
    sniper:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M28 28h70v17H28z"/><path d="M97 32h70v5H97z"/><path d="M10 26h20v8H10z"/><path d="M48 44h13v18H48z"/><path d="M72 44h13l7 19H81z"/><path d="M48 15h55v6H48z"/><path d="M61 10h30v6H61z"/></svg>',
    shotgun:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M22 29h70v17H22z"/><path d="M90 31h75v6H90z"/><path d="M8 27h16v8H8z"/><path d="M45 45h13v18H45z"/><path d="M70 44h12l8 19H79z"/><path d="M104 39h47v4h-47z"/></svg>',
    pistol:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M49 20h76v22H49z"/><path d="M113 25h29v12h-29z"/><path d="M63 40h34L88 65H68z"/></svg>',
    'pistol-compact':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M54 22h68v20H54z"/><path d="M111 27h24v10h-24z"/><path d="M68 40h30L90 64H73z"/></svg>',
    'machine-pistol':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M47 19h79v22H47z"/><path d="M118 24h31v12h-31z"/><path d="M64 40h35L91 65H70z"/><path d="M101 41h11v22h-11z"/></svg>',
    revolver:
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M45 23h55v20H45z"/><circle cx="100" cy="33" r="15"/><path d="M111 27h38v10h-38z"/><path d="M65 42h28L84 65H70z"/></svg>',
    'pistol-heavy':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M38 18h91v25H38z"/><path d="M118 24h34v14h-34z"/><path d="M59 41h39L90 66H66z"/></svg>',
    'revolver-heavy':
      '<svg viewBox="0 0 180 72" aria-hidden="true"><path d="M36 21h65v23H36z"/><circle cx="103" cy="33" r="17"/><path d="M116 26h43v12h-43z"/><path d="M61 42h34L86 66H67z"/></svg>',
  };

  const WEAPON_SILHOUETTE_ALIASES = {
    'rifle-long': 'rifle',
    'lmg-bullpup': 'lmg',
    'lmg-box': 'lmg',
    'lmg-rifle': 'lmg',
    'lmg-belt': 'lmg',
    'lmg-drum': 'lmg',
    'dmr-long': 'dmr',
    'dmr-modern': 'dmr',
    'dmr-svd': 'dmr',
    'sniper-classic': 'sniper',
    'sniper-heavy': 'sniper',
    'sniper-modern': 'sniper',
  };

  function weaponSilhouette(name) {
    return (
      WEAPON_SILHOUETTES[name] ||
      WEAPON_SILHOUETTES[WEAPON_SILHOUETTE_ALIASES[name]] ||
      WEAPON_SILHOUETTES.rifle
    );
  }

  const GADGET_SILHOUETTES = {
    bandage:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><rect x="43" y="24" width="74" height="27" rx="13"/><circle cx="67" cy="37.5" r="5" fill="var(--vehicle-cut)"/><circle cx="80" cy="37.5" r="5" fill="var(--vehicle-cut)"/><circle cx="93" cy="37.5" r="5" fill="var(--vehicle-cut)"/></svg>',
    binoculars:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M31 24h32l7 13v21H34L24 48zM97 24h32l7 24-10 10H90V37z"/><path d="M60 31h40v17H60z"/><circle cx="48" cy="50" r="15"/><circle cx="112" cy="50" r="15"/></svg>',
    'binoculars-advanced':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M27 22h37l8 15v22H32L20 48zM96 22h37l7 26-12 11H88V37z"/><path d="M58 28h44v19H58zM43 14h74v9H43z"/><circle cx="47" cy="50" r="15"/><circle cx="113" cy="50" r="15"/></svg>',
    rangefinder:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M42 20h76l13 15v22H31V35z"/><circle cx="80" cy="39" r="15" fill="var(--vehicle-cut)"/><path d="M74 25h12v28H74zM66 33h28v12H66z"/></svg>',
    explosive:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M36 24h25v31H36zM67 24h25v31H67zM98 24h25v31H98z"/><path d="M31 31h97v6H31zm0 15h97v6H31z"/><path d="M78 13h5v12h-5zm4 0h29v4H82z"/></svg>',
    claymore:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M48 22h64l8 31H40z"/><path d="M55 53h7L48 70h-6zm43 0h7l13 17h-7z"/><circle cx="64" cy="37" r="4" fill="var(--vehicle-cut)"/><circle cx="80" cy="37" r="4" fill="var(--vehicle-cut)"/><circle cx="96" cy="37" r="4" fill="var(--vehicle-cut)"/></svg>',
    launcher:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M29 28h89v18H29zM118 31h28v12h-28zM17 24h19v26H17z"/><path d="M58 45h18L67 66H52zM91 44h12l10 22h-12z"/><path d="M47 21h54v7H47z"/></svg>',
    'round-mine':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><ellipse cx="80" cy="42" rx="39" ry="22"/><path d="M67 15h26v12H67zM77 7h6v11h-6z"/><circle cx="80" cy="42" r="11" fill="var(--vehicle-cut)"/></svg>',
    soflam:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M38 22h82l12 24H28z"/><circle cx="80" cy="34" r="12" fill="var(--vehicle-cut)"/><path d="M76 46h8v13h-8zM80 56l-27 15h-9l31-19zm0 0 27 15h9L85 52z"/></svg>',
    'explosive-vest':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M39 18h82v38H39z"/><path d="M50 25h20v24H50zm45 0h20v24H95z" fill="var(--vehicle-cut)"/><path d="M75 18h10v38H75zM32 28h8v18h-8zm89 0h8v18h-8z"/></svg>',
    trophy:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><circle cx="80" cy="22" r="13"/><path d="M75 33h10v16H75zM80 45L51 69h-9l32-28zm0 0 29 24h9L86 41zm0 0v24h-7l3-28z"/></svg>',
    beacon:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M58 36h44v27H58zM76 11h8v26h-8z"/><path d="M51 27l6-6 12 12-6 6zm58 0-6-6-12 12 6 6z"/><circle cx="80" cy="15" r="8"/></svg>',
    'ammo-small':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M39 27h82v33H39zM50 18h60v10H50z"/><path d="M69 36h22v6H69zM76 32h8v15h-8z" fill="var(--vehicle-cut)"/></svg>',
    medkit:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M37 24h86v38H37zM62 14h36v11H62z"/><path d="M73 31h14v24H73zM68 36h24v14H68z" fill="var(--vehicle-cut)"/></svg>',
    rpg:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M25 31h102v11H25zM8 27l28-11v41L8 46zM126 27l26 10-26 10z"/><path d="M65 40h14L70 66H58zM91 41h9l8 18h-10zM52 24h46v7H52z"/></svg>',
    shield:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M50 10h60v42L80 69 50 52z"/><rect x="67" y="20" width="26" height="14" rx="3" fill="var(--vehicle-cut)"/></svg>',
    sledgehammer:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M39 13h61v18H39zM93 9h18v26H93z"/><path d="M66 27l10 8-39 37-10-8z"/></svg>',
    'sensor-tripod':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><circle cx="80" cy="21" r="16"/><path d="M75 35h10v12H75zM79 43L48 70h-9l35-31zm2 0 31 27h9L86 39zm-5 0h8v27h-8z"/></svg>',
    'ammo-heavy':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M27 24h106v39H27zM42 15h76v10H42z"/><path d="M68 34h24v7H68zM76 29h8v18h-8z" fill="var(--vehicle-cut)"/></svg>',
    'grappling-hook':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M33 32h74v18H33zM106 27h24v28h-24zM19 27h15v28H19z"/><path d="M58 48h15L65 68H53zM128 17h7v21h-7z"/><path d="M131 15c16 0 20 10 20 18h-8c0-6-3-10-12-10zm0 0c-16 0-20 10-20 18h8c0-6 3-10 12-10z"/></svg>',
    drone:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M57 30h46l13 18H44z"/><path d="M27 19h42v5H27zm64 0h42v5H91zM45 21h6v19h-6zm64 0h6v19h-6z"/><circle cx="48" cy="22" r="7"/><circle cx="112" cy="22" r="7"/><path d="M75 48h10v15H75z"/></svg>',
    pickaxe:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M35 20c24-15 62-15 90 2l-5 8c-25-10-52-10-80-1z"/><path d="M76 24l11 4-21 44-11-5z"/></svg>',
    'frag-grenade':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M61 28h38l10 15-9 24H60l-9-24zM68 17h24v12H68z"/><path d="M88 13h24v6H88zM105 16h7v17h-7z"/><path d="M58 39h45v5H58zm-2 13h49v5H56zM71 28h5v39h-5zm14 0h5v39h-5z" fill="var(--vehicle-cut)"/></svg>',
    'impact-grenade':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M57 27h46l8 15-12 25H61L49 42zM68 15h24v13H68z"/><path d="M91 12h24v6H91zM108 15h7v17h-7z"/><circle cx="80" cy="47" r="9" fill="var(--vehicle-cut)"/></svg>',
    'anti-vehicle-grenade':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M31 40l24-19 19 11 31-15 24 12-27 38H55z"/><path d="M70 26h20v9H70zM77 15h6v12h-6z"/></svg>',
    'smoke-grenade':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M58 25h44v42H58zM66 14h28v12H66z"/><path d="M91 11h25v6H91zM109 14h7v17h-7zM65 35h30v7H65z" fill="var(--vehicle-cut)"/></svg>',
    flare:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M42 57l62-42 11 16-62 42z"/><path d="M98 10l10-7 18 27-10 7z"/></svg>',
    flashbang:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M59 26h42v41H59zM67 14h26v13H67z"/><path d="M91 11h25v6H91zM109 14h7v17h-7z"/><path d="M64 36h32v5H64zm0 10h32v5H64zm0 10h32v5H64z" fill="var(--vehicle-cut)"/></svg>',
  };

  function gadgetSilhouette(name) {
    return GADGET_SILHOUETTES[name] || GADGET_SILHOUETTES.explosive;
  }

  const VEHICLE_SILHOUETTES = {
    jeep:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M18 43h12l8-18h48l17 18h27v13H18z"/><path d="M48 29h30l12 14H42z" fill="var(--vehicle-cut)"/><circle cx="43" cy="57" r="10"/><circle cx="112" cy="57" r="10"/></svg>',
    utility:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M12 42h20l10-22h53l19 22h30v14H12z"/><path d="M50 25h35l14 17H42z" fill="var(--vehicle-cut)"/><path d="M67 15h5v8h-5z"/><circle cx="38" cy="57" r="10"/><circle cx="119" cy="57" r="10"/></svg>',
    carrier:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M12 31l20-14h83l26 21-8 18H18z"/><path d="M48 22h28v13H34z" fill="var(--vehicle-cut)"/><path d="M87 22h22l16 13H87z" fill="var(--vehicle-cut)"/><circle cx="38" cy="57" r="9"/><circle cx="75" cy="57" r="9"/><circle cx="113" cy="57" r="9"/></svg>',
    truck:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M8 24h84v31H8z"/><path d="M92 31h31l18 14v10H92z"/><path d="M100 35h18l10 10h-28z" fill="var(--vehicle-cut)"/><circle cx="31" cy="57" r="10"/><circle cx="79" cy="57" r="10"/><circle cx="122" cy="57" r="10"/></svg>',
    buggy:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M20 45h20l18-27h36l21 27h25v10H20z"/><path d="M60 24h28l14 21H47z" fill="var(--vehicle-cut)"/><path d="M52 17h47v4H52z"/><circle cx="43" cy="56" r="11"/><circle cx="117" cy="56" r="11"/></svg>',
    'open-jeep':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M18 43h25l8-19h38l14 19h31v13H18z"/><path d="M54 24h4v19h-4zm34 0h4v19h-4z"/><path d="M52 22h40v4H52z"/><circle cx="42" cy="57" r="10"/><circle cx="112" cy="57" r="10"/></svg>',
    quad:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M46 42h18l11-14h27l12 14h14v10H46z"/><path d="M87 17h6v13h-6zm-8-3h22v5H79z"/><circle cx="57" cy="55" r="12"/><circle cx="118" cy="55" r="12"/></svg>',
    command:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M12 24h97l29 21v11H12z"/><path d="M24 31h23v12H24zm31 0h23v12H55zm51 0h16l12 12h-28z" fill="var(--vehicle-cut)"/><path d="M68 13h5v11h-5zm-5-3h15v4H63z"/><circle cx="36" cy="57" r="9"/><circle cx="78" cy="57" r="9"/><circle cx="119" cy="57" r="9"/></svg>',
    engineering:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M16 37h84l23 18H16z"/><path d="M43 19h45l15 18H32z"/><path d="M111 12h7v25h-7zm7 0h25v6h-25z"/><path d="M21 55h108l-9 12H30z"/></svg>',
    aa:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M18 40h104l18 16H18z"/><path d="M58 27h48v13H58z"/><path d="M76 10h6v18h-6zm12 0h6v18h-6z"/><path d="M73 8h12v4H73zm12 0h12v4H85z"/><circle cx="39" cy="57" r="9"/><circle cx="76" cy="57" r="9"/><circle cx="116" cy="57" r="9"/></svg>',
    support:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M14 37h99l28 18H14z"/><path d="M52 22h52l17 15H40z"/><path d="M73 12h31v7H73zm28 2h44v4h-44z"/><circle cx="38" cy="57" r="9"/><circle cx="78" cy="57" r="9"/><circle cx="119" cy="57" r="9"/></svg>',
    'light-armor':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M14 38l25-18h73l31 24-8 13H20z"/><path d="M67 12h35l15 11H55z"/><path d="M91 9h55v4H91z"/><circle cx="39" cy="57" r="9"/><circle cx="75" cy="57" r="9"/><circle cx="113" cy="57" r="9"/></svg>',
    ifv:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M10 35l25-18h83l28 26-10 14H17z"/><path d="M62 9h42l15 13H50z"/><path d="M96 7h54v4H96z"/><circle cx="32" cy="57" r="9"/><circle cx="67" cy="57" r="9"/><circle cx="103" cy="57" r="9"/><circle cx="132" cy="57" r="9"/></svg>',
    'tank-a':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M17 42h112l20 10-13 14H29L9 54z"/><path d="M49 25h59l22 17H34z"/><path d="M82 18h30v8H82zm27 1h48v5h-48z"/><path d="M34 53h92v8H34z" fill="var(--vehicle-cut)"/></svg>',
    'tank-b':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M12 40h116l23 12-15 14H26L6 53z"/><path d="M55 22h53l17 18H38z"/><path d="M72 13h38v10H72zm34 2h50v5h-50z"/><path d="M29 52h101v9H29z" fill="var(--vehicle-cut)"/></svg>',
    'patrol-boat':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M8 44h143l-20 19H31z"/><path d="M62 28h46l14 16H48z"/><path d="M78 17h6v11h-6zm-16 8h47v4H62z"/><path d="M87 14h43v4H87z"/></svg>',
    'assault-boat':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M5 43h150l-25 20H28z"/><path d="M46 27h69l16 16H36z"/><path d="M68 18h36v10H68z"/><path d="M92 15h50v4H92z"/></svg>',
    interceptor:
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M7 47h147l-31 16H31z"/><path d="M70 31h44l15 16H54z"/><path d="M83 20h7v11h-7zm-18 9h56v4H65z"/><path d="M24 42h36v5H24z"/></svg>',
    'scout-heli':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M52 29h43l19 15-14 15H60L44 43z"/><path d="M101 38h33l18 7h-43z"/><path d="M74 14h5v16h-5z"/><path d="M25 12h103v4H25z"/><path d="M55 58h53v4H55z"/></svg>',
    'utility-heli':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M39 30h64l20 15-15 14H48L30 43z"/><path d="M112 39h30l15 6h-42z"/><path d="M70 14h5v17h-5z"/><path d="M15 12h118v4H15z"/><path d="M45 59h72v4H45z"/></svg>',
    'transport-heli':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M30 28h83l20 17-16 14H39L21 42z"/><path d="M123 39h25l10 6h-32z"/><path d="M69 12h5v17h-5z"/><path d="M8 10h126v4H8z"/><path d="M38 59h86v5H38z"/></svg>',
    'armed-heli':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M48 30h58l22 14-16 15H55L38 43z"/><path d="M116 38h31l11 6h-36z"/><path d="M74 13h5v18h-5z"/><path d="M17 11h118v4H17z"/><path d="M41 51h16v5H41zm72 0h18v5h-18z"/><path d="M55 59h72v4H55z"/></svg>',
    'attack-heli':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M57 30h48l26 14-20 15H63L43 43z"/><path d="M119 39h30l10 5h-35z"/><path d="M76 12h5v19h-5z"/><path d="M18 10h120v4H18z"/><path d="M42 48h23v6H42zm70 0h25v6h-25z"/><path d="M60 59h62v4H60z"/></svg>',
    'heavy-heli':
      '<svg viewBox="0 0 160 72" aria-hidden="true"><path d="M26 28h91l20 17-15 14H35L17 41z"/><path d="M126 39h23l10 6h-29z"/><path d="M59 12h5v17h-5zm53 0h5v17h-5z"/><path d="M6 10h116v4H6zm62 0h86v4H68z"/><path d="M36 59h94v5H36z"/></svg>',
  };

  function finite(value) {
    value = Number(value);
    return isFinite(value) ? value : 0;
  }

  function pct(value, max) {
    if (!(max > 0)) return 0;
    return Math.max(0, Math.min(100, (value / max) * 100));
  }

  function formatHours(seconds) {
    return (Math.max(0, finite(seconds)) / 3600).toFixed(3) + ' 小时';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const SoldierMenu = {
    open: false,
    active: 'home',

    init() {
      if (this._bound) return;
      this._bound = true;
      this.root = document.getElementById('soldier-browser');
      this.nav = document.getElementById('soldier-nav');
      this.content = document.getElementById('soldier-content');
      if (!this.root || !this.nav || !this.content) return;
      this._renderNav();
      this.nav.addEventListener('click', (event) => {
        const button = event.target.closest('[data-soldier-page]');
        if (!button || !this.nav.contains(button)) return;
        this.select(button.getAttribute('data-soldier-page'));
      });
    },

    show() {
      this.init();
      if (!this.root) return;
      this.open = true;
      this.root.classList.remove('hidden');
      const mode = document.getElementById('mode-overlay');
      if (mode) mode.classList.add('soldier-browser-open');
      this._syncTopTabs();
      this.select(this.active || 'home');
    },

    hide() {
      this.open = false;
      if (this.root) this.root.classList.add('hidden');
      const mode = document.getElementById('mode-overlay');
      if (mode) mode.classList.remove('soldier-browser-open');
      this._syncTopTabs();
    },

    _syncTopTabs() {
      document.querySelectorAll('[data-mode-tab]').forEach((button) => {
        const selected = this.open
          ? button.getAttribute('data-mode-tab') === 'soldier'
          : button.getAttribute('data-mode-tab') === 'multiplayer';
        button.classList.toggle('active', selected);
      });
    },

    _renderNav() {
      this.nav.innerHTML = '';
      for (let i = 0; i < NAV.length; i++) {
        const item = NAV[i];
        const button = document.createElement('button');
        button.type = 'button';
        button.className =
          'soldier-nav-item' +
          (item.child ? ' child' : '') +
          (item.group ? ' group' : '');
        button.setAttribute('data-soldier-page', item.id);
        if (item.icon) {
          const icon = document.createElement('span');
          icon.className = 'soldier-nav-icon';
          icon.textContent = item.icon;
          button.appendChild(icon);
        }
        const label = document.createElement('span');
        label.textContent = item.label;
        button.appendChild(label);
        this.nav.appendChild(button);
      }
    },

    select(page) {
      this.active = page || 'home';
      if (this.nav) {
        this.nav.querySelectorAll('[data-soldier-page]').forEach((button) => {
          button.classList.toggle(
            'active',
            button.getAttribute('data-soldier-page') === this.active
          );
        });
      }
      if (!this.content) return;
      if (this.active === 'home') this._renderHome();
      else if (this.active === 'stats') this._renderStats();
      else if (this.active === 'achievements') this._renderAchievements();
      else if (this.active === 'weapons') this._renderWeapons(null);
      else if (this.active.indexOf('weapon-') === 0) {
        this._renderWeapons(this.active.slice(7));
      } else if (this.active === 'gadgets') this._renderGadgets(null);
      else if (this.active.indexOf('gadget-') === 0) {
        this._renderGadgets(this.active.slice(7));
      }
      else if (this.active === 'vehicles') this._renderVehicleOverview();
      else if (this.active.indexOf('vehicle-') === 0) {
        this._renderVehicles(this.active.slice(8));
      } else {
        this._renderHome();
      }
    },

    _profile() {
      const scoring = global.VF && global.VF.Scoring;
      const snapshot = scoring && scoring.getSnapshot ? scoring.getSnapshot() : null;
      const players = snapshot && snapshot.players ? snapshot.players : [];
      for (let i = 0; i < players.length; i++) {
        if (players[i].id === 'player-local') return players[i];
      }
      return {
        id: 'player-local',
        score: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        revives: 0,
        heals: 0,
        resupplies: 0,
        captures: 0,
        defends: 0,
        spots: 0,
        ribbons: [],
      };
    },

    _classInfo() {
      const game = global.VF && global.VF.game;
      const classId =
        (game && game.player && game.player.classId) ||
        (game && game.playerClass) ||
        'assault';
      const classes = global.VF && global.VF.Soldier && global.VF.Soldier.CLASSES;
      if (classes) {
        for (let i = 0; i < classes.length; i++) {
          if (classes[i].id === classId) return classes[i];
        }
      }
      return { id: classId, nameZh: '突击', role: '进攻与突破' };
    },

    _weaponInfo() {
      const game = global.VF && global.VF.game;
      const current = game && game.weapons && game.weapons.current;
      const defs = global.VF && global.VF.WEAPONS;
      return (defs && defs[current]) || (defs && defs.ar) || { name: 'AKM', caliber: '' };
    },

    _renderHome() {
      const p = this._profile();
      const game = global.VF && global.VF.game;
      const conquest = global.VF && global.VF.Conquest;
      const elapsed = Math.max(
        0,
        finite(p.playtimeSec),
        finite(conquest && conquest.elapsed)
      );
      const minutes = Math.max(1 / 60, elapsed / 60);
      const kd = finite(p.kills) / Math.max(1, finite(p.deaths));
      const spm = finite(p.score) / minutes;
      const kpm = finite(p.kills) / minutes;
      const shots = finite(p.shots);
      const hits = Math.min(shots, finite(p.hits));
      const accuracy = shots > 0 ? (hits / shots) * 100 : 0;
      const classInfo = this._classInfo();
      const weapon = this._weaponInfo();
      const profileActivity =
        finite(p.kills) +
        finite(p.deaths) +
        finite(p.assists) +
        finite(p.revives) +
        finite(p.heals) +
        finite(p.resupplies) +
        finite(p.captures) +
        finite(p.defends) +
        finite(p.spots);
      const hasProfileData = profileActivity > 0 || finite(p.score) > 0;
      const hasCombatData = finite(p.kills) + finite(p.deaths) > 0;
      const playerTeam =
        (game && game.player && game.player.team) ||
        (game && game.world && game.world._playerTeam) ||
        p.team ||
        'ally';
      const currentRoundEnded = !!(conquest && conquest._ended && conquest._winner);
      const hasStoredRoundStats = p.roundWins != null || p.roundLosses != null;
      const roundWins =
        finite(p.roundWins) +
        (!hasStoredRoundStats && currentRoundEnded && conquest._winner === playerTeam ? 1 : 0);
      const roundLosses =
        finite(p.roundLosses) +
        (!hasStoredRoundStats && currentRoundEnded && conquest._winner !== playerTeam ? 1 : 0);
      const hasRoundData = roundWins + roundLosses > 0;
      const winLoss = hasRoundData ? roundWins / Math.max(1, roundLosses) : 0;
      const weaponEntry = WEAPON_CATALOG.find(function (entry) {
        return entry.gameId && entry.gameId === weapon.id;
      });
      const gadgetName =
        classInfo.id === 'support'
          ? '重型弹药箱'
          : classInfo.id === 'engineer'
            ? 'C4 炸药'
            : classInfo.id === 'recon'
              ? 'MDX-201 运动传感器'
              : '部署信标';
      const gadgetId =
        classInfo.id === 'support'
          ? 'supply'
          : classInfo.id === 'engineer'
            ? 'charge'
            : classInfo.id === 'recon'
              ? 'sensor'
              : 'beacon';
      const gadgetEntry = GADGET_CATALOG.find(function (entry) {
        return entry.gameId === gadgetId;
      });
      const supportActions =
        finite(p.revives) + finite(p.heals) + finite(p.resupplies) + finite(p.spots);
      const stats = [
        {
          value: hasCombatData ? kd.toFixed(2) : '0.00',
          label: '击杀/死亡',
          progress: hasCombatData ? pct(kd, 3) : 0,
          hasData: hasCombatData,
        },
        {
          value: hasRoundData ? winLoss.toFixed(1) : '0.0',
          label: '胜利/败北',
          progress: hasRoundData ? pct(winLoss, 3) : 0,
          hasData: hasRoundData,
        },
        {
          value: shots > 0 ? Math.round(accuracy) + '%' : '0%',
          label: '准确度',
          progress: shots > 0 ? accuracy : 0,
          hasData: shots > 0,
        },
        {
          value: finite(p.score) > 0 ? String(Math.round(spm)) : '0.0',
          label: '积分/分钟',
          progress: finite(p.score) > 0 ? pct(spm, 1000) : 0,
          hasData: finite(p.score) > 0,
        },
        {
          value: finite(p.kills) > 0 ? kpm.toFixed(1) : '0.0',
          label: '击杀/分钟',
          progress: finite(p.kills) > 0 ? pct(kpm, 3) : 0,
          hasData: finite(p.kills) > 0,
        },
      ];
      this.content.innerHTML =
        '<section class="soldier-home">' +
        '<div class="soldier-stat-rings">' +
        stats
          .map(function (stat) {
            return (
              '<div class="soldier-stat-ring' +
              (stat.hasData ? '' : ' empty') +
              '" style="--soldier-progress:' +
              stat.progress.toFixed(1) +
              '%"><b>' +
              escapeHtml(stat.value) +
              '</b><span>' +
              escapeHtml(stat.label) +
              '</span></div>'
            );
          })
          .join('') +
        '</div>' +
        '<div class="soldier-loadout-block">' +
        '<h3>当前装备</h3>' +
        '<p>点击武器栏进入装备界面</p>' +
        '<div id="soldier-loadout-strip" class="deploy-loadout-strip" aria-label="当前装备"></div>' +
        '</div>' +
        '<div class="soldier-favorites">' +
        this._summaryCard({
          title: '最爱武器',
          available: finite(p.kills) > 0,
          name: weapon.name || weapon.model,
          detail: Math.round(finite(p.kills)) + ' 次击杀',
          svg: weaponEntry && weaponSilhouette(weaponEntry.silhouette),
          secondaryTitle: '最常游玩兵种',
          secondaryAvailable: hasProfileData,
          secondaryName: classInfo.nameZh + '兵',
          secondaryDetail: formatHours(elapsed),
          secondaryIcon: '✥',
        }) +
        this._summaryCard({
          title: '最爱小工具',
          available: supportActions > 0,
          name: gadgetName,
          detail: Math.round(supportActions) + ' 次有效使用',
          svg: gadgetEntry && gadgetSilhouette(gadgetEntry.silhouette),
          secondaryTitle: '最高击杀兵种',
          secondaryAvailable: finite(p.kills) > 0,
          secondaryName: classInfo.nameZh + '兵',
          secondaryDetail: Math.round(finite(p.kills)) + ' 次击杀',
          secondaryIcon: '◒',
        }) +
        this._summaryCard({
          title: '最爱载具',
          available: false,
          secondaryTitle: '最高得分兵种',
          secondaryAvailable: finite(p.score) > 0,
          secondaryName: classInfo.nameZh + '兵',
          secondaryDetail: Math.round(finite(p.score)).toLocaleString('zh-CN') + ' 总得分',
          secondaryIcon: '◒',
        }) +
        '</div>' +
        '<div class="soldier-prestige">军衔等级 <b>' +
        Math.max(1, Math.floor(finite(p.score) / 1000) + 1) +
        '</b><span>↑</span></div>' +
        '</section>';
      if (global.VF.UI && global.VF.UI._syncDeployClassDetails) {
        global.VF.UI._syncDeployClassDetails(classInfo);
      }
    },

    _summaryCard(config) {
      config = config || {};
      const available = !!config.available;
      const secondaryAvailable = !!config.secondaryAvailable;
      return (
        '<article class="soldier-summary-card' +
        (available ? '' : ' empty') +
        '"><h3>' +
        escapeHtml(config.title || '最爱项目') +
        '</h3><div class="soldier-favorite-primary"><div class="soldier-summary-icon">' +
        (available && config.svg ? config.svg : '<span>—</span>') +
        '</div><div><strong>' +
        escapeHtml(available ? config.name || '—' : '—') +
        '</strong><small>' +
        escapeHtml(available ? config.detail || '—' : '—') +
        '</small></div></div><h4>' +
        escapeHtml(config.secondaryTitle || '兵种数据') +
        '</h4><div class="soldier-favorite-secondary' +
        (secondaryAvailable ? '' : ' empty') +
        '"><span>' +
        escapeHtml(secondaryAvailable ? config.secondaryIcon || '✥' : '—') +
        '</span><strong>' +
        escapeHtml(secondaryAvailable ? config.secondaryName || '—' : '—') +
        '</strong><small>' +
        escapeHtml(secondaryAvailable ? config.secondaryDetail || '—' : '—') +
        '</small></div></article>'
      );
    },

    _renderStats() {
      const p = this._profile();
      const game = global.VF && global.VF.game;
      const conquest = global.VF && global.VF.Conquest;
      const elapsed = finite(conquest && conquest.elapsed);
      const playerTeam =
        (game && game.player && game.player.team) ||
        (game && game.world && game.world._playerTeam) ||
        p.team ||
        'ally';
      const winner = conquest && conquest._winner;
      const roundEnded = !!(conquest && conquest._ended);
      const currentClass = this._classInfo().id;
      const isLeader = !!(game && game.player && game.player.isSquadLeader);
      const number = function (value) {
        return Math.round(finite(value)).toLocaleString('zh-CN');
      };
      const tile = function (icon, label, value) {
        return (
          '<article class="soldier-stat-tile"><span class="soldier-stat-icon">' +
          escapeHtml(icon) +
          '</span><div><small>' +
          escapeHtml(label) +
          '</small><strong>' +
          escapeHtml(value) +
          '</strong></div></article>'
        );
      };
      const section = function (title, modifier, tiles) {
        return (
          '<section class="soldier-stat-section"><h2>' +
          escapeHtml(title) +
          '</h2><div class="soldier-stat-tiles ' +
          modifier +
          '">' +
          tiles.join('') +
          '</div></section>'
        );
      };
      const classRows = [
        { id: 'leader', name: '小队队长', icon: '⌃', active: isLeader },
        { id: 'assault', name: '突击兵', icon: '✥', active: currentClass === 'assault' },
        { id: 'engineer', name: '工程兵', icon: '◒', active: currentClass === 'engineer' },
        { id: 'support', name: '支援兵', icon: '▥', active: currentClass === 'support' },
        { id: 'recon', name: '侦察兵', icon: '⌖', active: currentClass === 'recon' },
      ];
      this.content.innerHTML =
        '<div class="soldier-stats-panel">' +
        section('一般', 'columns-4', [
          tile('▮', '击杀', number(p.kills)),
          tile('☠', '死亡', number(p.deaths)),
          tile('⌁', '已游玩', formatHours(elapsed)),
          tile('↑', '总得分', number(p.score)),
        ]) +
        section('回合', 'columns-3', [
          tile('◉', '获胜回合数', roundEnded && winner === playerTeam ? '1' : '0'),
          tile('◉', '平局回合数', roundEnded && !winner ? '1' : '0'),
          tile('◉', '失败回合数', roundEnded && winner && winner !== playerTeam ? '1' : '0'),
        ]) +
        section('队伍', 'columns-5', [
          tile('♙', '救援队友', number(p.revives)),
          tile('♙', '治疗友军', number(p.heals)),
          tile('♙', '补给友军', number(p.resupplies)),
          tile('⌖', '标记敌军', number(p.spots)),
          tile('☠', '助攻', number(p.assists)),
        ]) +
        section('目标', 'columns-1', [
          tile('▲', '完成目标', number(finite(p.captures) + finite(p.defends))),
        ]) +
        section('载具', 'columns-3', [
          tile('▰', '使用载具击杀', '0'),
          tile('✹', '摧毁载具', '0'),
          tile('▰', '维修载具生命值', '0'),
        ]) +
        section('枪械', 'columns-4', [
          tile('▰', '总击杀', number(p.kills)),
          tile('◻', '命中率', '—'),
          tile('⌁', '最远距离击杀', '—'),
          tile('☠', '爆头数', '0'),
        ]) +
        '<section class="soldier-stat-section soldier-class-section"><h2>兵种数据</h2>' +
        '<div class="soldier-class-table">' +
        classRows
          .map(function (row) {
            const active = row.active;
            return (
              '<article class="' +
              (active ? 'current' : '') +
              '"><div class="soldier-class-name"><span>' +
              escapeHtml(row.icon) +
              '</span><strong>' +
              escapeHtml(row.name) +
              '</strong></div><div><b>' +
              (active ? number(p.kills) : '0') +
              '</b><small>击杀数</small></div><div><b>' +
              (active ? number(p.score) : '0') +
              '</b><small>总得分</small></div><div><b>' +
              (active ? formatHours(elapsed) : '0.000 小时') +
              '</b><small>已游玩</small></div></article>'
            );
          })
          .join('') +
        '</div></section></div>';
    },

    _renderAchievements() {
      const p = this._profile();
      const unlocked = Array.isArray(p.ribbons) ? p.ribbons : [];
      const achievements = [
        ['首战告捷', '完成第一场征服对局', 'first-match'],
        ['战地救援', '累计完成 5 次复活', 'revive-5'],
        ['目标专家', '累计完成 5 次占领或防守', 'objective-5'],
        ['小队核心', '完成一项小队指令', 'squad-order'],
        ['百步穿杨', '累计完成 10 次远距击杀', 'marksman'],
        ['全面支援', '累计完成 20 次治疗或补给', 'support-20'],
      ];
      this.content.innerHTML =
        '<header class="soldier-page-head"><h2>成就</h2><p>完成战场目标以解锁档案徽章</p></header>' +
        '<div class="soldier-achievement-grid">' +
        achievements
          .map(function (entry) {
            const isUnlocked = unlocked.indexOf(entry[2]) >= 0;
            return (
              '<article class="' +
              (isUnlocked ? 'unlocked' : 'locked') +
              '"><span class="soldier-achievement-icon">✥</span><div><strong>' +
              escapeHtml(entry[0]) +
              '</strong><small>' +
              escapeHtml(entry[1]) +
              '</small></div><em>' +
              (isUnlocked ? '已解锁' : '未解锁') +
              '</em></article>'
            );
          })
          .join('') +
        '</div>';
    },

    _renderWeapons(filterId) {
      const defs = (global.VF && global.VF.WEAPONS) || {};
      const list = WEAPON_CATALOG.filter(function (weapon) {
        return (
          !filterId ||
          weapon.category === filterId ||
          (Array.isArray(weapon.also) && weapon.also.indexOf(filterId) >= 0)
        );
      });
      const title = filterId ? WEAPON_CATEGORY[filterId] || '武器' : '全部武器';
      this.content.innerHTML =
        '<header class="soldier-page-head"><h2>' +
        escapeHtml(title) +
        '</h2><p>步兵武器档案 · PDW 已并入冲锋枪，班用自动武器已并入轻机枪，各类副武器已并入手枪</p></header>';
      this._renderItems(
        list.map(function (weapon) {
          const live = weapon.gameId && defs[weapon.gameId];
          return {
            name: weapon.name,
            svg: weaponSilhouette(weapon.silhouette),
            line1:
              (live && live.caliber ? live.caliber + ' · ' : '') + '可使用',
            line2: live
              ? '伤害 ' +
                live.damage +
                ' · 射速 ' +
                live.fireRate +
                ' · 换弹 ' +
                live.reloadTime +
                's'
              : '最高连杀 0 · 0 击杀',
            available: !!live,
            gameId: weapon.gameId,
            arsenalSlot: weapon.category === 'pistol' ? 'secondary' : 'primary',
          };
        }),
        'weapon'
      );
    },

    _renderGadgets(filterId) {
      const list = GADGET_CATALOG.filter(function (gadget) {
        return !filterId || gadget.category === filterId;
      });
      const title = filterId ? GADGET_CATEGORY[filterId] || '装备' : '全部装备';
      this.content.innerHTML =
        '<header class="soldier-page-head"><h2>' +
        escapeHtml(title) +
        '</h2><p>步兵战术装备档案 · 急救、轻型、重型与投掷物均已使用中文名称</p></header>';
      this._renderItems(
        list.map(function (gadget) {
          return {
            name: gadget.name,
            svg: gadgetSilhouette(gadget.silhouette),
            line1: gadget.rank > 0 ? '解锁等级 ' + gadget.rank : '基础装备',
            line2: gadget.detail,
            available: !!gadget.gameId,
            gameId: gadget.gameId,
            arsenalSlot: gadget.category === 'throwable' ? 'grenade' : '',
          };
        }),
        'gadget'
      );
    },

    _renderVehicleOverview() {
      const all = [];
      Object.keys(VEHICLES).forEach(function (key) {
        all.push({
          name: NAV.find(function (entry) {
            return entry.id === 'vehicle-' + key;
          }).label,
          svg: VEHICLE_SILHOUETTES[VEHICLES[key][0].silhouette],
          line1: VEHICLES[key].length + ' 个档案条目',
          line2: '载具系统尚未接入',
          available: false,
        });
      });
      this.content.innerHTML =
        '<header class="soldier-page-head"><h2>载具档案</h2><p>仅展示规划分类；当前版本不包含可驾驶载具</p></header>';
      this._renderItems(all, 'vehicle');
    },

    _renderVehicles(category) {
      const source = VEHICLES[category] || [];
      const nav = NAV.find(function (entry) {
        return entry.id === 'vehicle-' + category;
      });
      this.content.innerHTML =
        '<header class="soldier-page-head"><h2>' +
        escapeHtml((nav && nav.label) || '载具') +
        '</h2><p>该栏目尚未接入实际载具功能</p></header>';
      this._renderItems(
        source.map(function (vehicle) {
          return {
            name: vehicle.name,
            svg: VEHICLE_SILHOUETTES[vehicle.silhouette],
            line1: '击毁数 0',
            line2: '使用次数 0',
            available: false,
          };
        }),
        'vehicle'
      );
    },

    _renderItems(items, kind) {
      const grid = document.createElement('div');
      grid.className = 'soldier-item-grid ' + kind;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const card = document.createElement('article');
        card.className =
          'soldier-item-card' +
          (item.available ? '' : ' unavailable') +
          (item.gameId && item.arsenalSlot ? ' clickable' : '');
        if (item.gameId && item.arsenalSlot) {
          card.dataset.gameId = item.gameId;
          if (item.arsenalSlot) card.dataset.arsenalSlot = item.arsenalSlot;
          card.addEventListener('click', function () {
            if (!global.VF.UI || !global.VF.UI.openArsenal) return;
            global.VF.UI.openArsenal({
              slot: card.dataset.arsenalSlot || 'primary',
              itemId: card.dataset.gameId,
              source: 'soldier',
            });
          });
        }
        const name = document.createElement('h3');
        name.textContent = item.name;
        const icon = document.createElement('div');
        icon.className = 'soldier-item-icon';
        if (item.svg) icon.innerHTML = item.svg;
        else icon.textContent = item.icon;
        const line1 = document.createElement('small');
        line1.textContent = item.line1 || '';
        const line2 = document.createElement('p');
        line2.textContent = item.line2 || '';
        card.append(name, icon, line1, line2);
        if (!item.available) {
          const lock = document.createElement('em');
          lock.textContent = '未部署';
          card.appendChild(lock);
        }
        grid.appendChild(card);
      }
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'soldier-content-empty';
        empty.textContent = '该分类暂无档案';
        grid.appendChild(empty);
      }
      this.content.appendChild(grid);
    },
  };

  global.VF = global.VF || {};
  global.VF.SoldierMenu = SoldierMenu;
})(typeof window !== 'undefined' ? window : globalThis);
