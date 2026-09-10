/**
 * soldier.js — Voxel soldier classes + AI variants + FPS view-model
 */
(function (global) {
  'use strict';

  const PALETTE = {
    olive: 0x4a5c28,
    oliveDark: 0x2f3d1c,
    camo: 0x5a6a3a,
    camoGrey: 0x5a6058,
    vest: 0x2a2e28,
    skin: 0xc4a882,
    skinLight: 0xd4b896,
    glove: 0x1a1a1a,
    boot: 0x151515,
    orange: 0xe07020,
    gun: 0x2e343c,
    gunDark: 0x1a1e24,
    wood: 0x6b4a2e,
    eye: 0x3d5c2e,
    mustache: 0x5a4030,
    white: 0xe8e8e8,
    whiteDim: 0xc8c8c8,
    grey: 0x8a8a8a,
    redCross: 0xd02828,
    blonde: 0xd4b060,
    ghillie: 0x4a6a30,
    ghillieDark: 0x3a5020,
    ghillieBrown: 0x5a4a28,
    charcoal: 0x2a2a2e,
    plate: 0x3a3a40,
    bandana: 0xc02028,
    enemyRed: 0x6a2020,
    enemyDark: 0x3a1010,
    enemyOrange: 0xaa4020,
  };

  /** Playable classes shown on the select screen */
  const CLASSES = [
    {
      id: 'assault',
      nameEn: 'Assault',
      nameZh: '突击',
      label: 'Assault｜突击',
      role: '进攻与突破',
      blurb:
        '进攻型步兵。主动 X：注射战斗兴奋剂，快速恢复生命；冷却 60 秒，重生后立即刷新。被动：切枪/换弹更快。',
      activeSkill: {
        name: '战斗兴奋剂',
        desc: '按 X 快速回血 · 冷却 60 秒 · 最多携带 1 个 · 重生刷新',
      },
      passiveSkill: {
        name: '快速突入',
        desc: '切枪/换弹更快；执行进攻命令时获得机动加成',
      },
    },
    {
      id: 'engineer',
      nameEn: 'Engineer',
      nameZh: '机枪兵',
      label: 'Gunner｜机枪兵',
      role: '载具维修与火力',
      blurb:
        '载具保障与阵地构筑。主动 X：靠近载具维修生命值（10/秒）；被动：建筑耐久提升。',
      activeSkill: {
        name: '修复装置',
        desc: '靠近载具按住 X 维修，准星旁显示载具血量，无过热',
      },
      passiveSkill: {
        name: '战地工程',
        desc: '建筑耐久提升；开局携带额外物料',
      },
    },
    {
      id: 'support',
      nameEn: 'Support',
      nameZh: '支援',
      label: 'Support｜支援',
      role: '救援与补给',
      blurb:
        '医疗与弹药保障。主动 X：对倒地队友读条拉起（3 秒，恢复 50% 生命）；被动：可复活任意友军。',
      activeSkill: {
        name: '急救装置',
        desc: '对倒地队友按住 X 拉起 3 秒，松开需重新读条，无冷却',
      },
      passiveSkill: {
        name: '全队救援',
        desc: '可复活全队友军；复活和拖拽更快',
      },
    },
    {
      id: 'recon',
      nameEn: 'Recon',
      nameZh: '侦察',
      label: 'Recon｜侦察',
      role: '标记与渗透',
      blurb:
        '远距观察与敌情标记。全兵种可按 Q 标记准星上的敌人（地图揭露 1 秒）；侦察兵标记持续 5 秒。',
      activeSkill: {
        name: '强化标记',
        desc: '对准敌人按 Q 标记，地图揭露 5 秒（其他兵种 1 秒）',
      },
      passiveSkill: {
        name: '观察手',
        desc: '标记持续更久；背后攻击伤害提升',
      },
    },
  ];

  const CLASS_ALIASES = {
    vanguard: 'assault',
    raider: 'assault',
    medic: 'support',
    juggernaut: 'support',
    ghost: 'recon',
    assault: 'assault',
    engineer: 'engineer',
    support: 'support',
    recon: 'recon',
  };

  function normalizeClassId(classId) {
    return CLASS_ALIASES[classId] || 'assault';
  }

  const _geoCache = {};
  const _matCache = {};
  function _mat(color) {
    const key = color | 0;
    if (_matCache[key]) return _matCache[key];
    const m = new THREE.MeshLambertMaterial({ color: key });
    _matCache[key] = m;
    return m;
  }

  function box(w, h, d, color, x, y, z) {
    const geoKey = w + 'x' + h + 'x' + d;
    let geo = _geoCache[geoKey];
    if (!geo) {
      geo = new THREE.BoxGeometry(w, h, d);
      _geoCache[geoKey] = geo;
    }
    const m = new THREE.Mesh(geo, _mat(color));
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }

  /** Shared materials for FPS viewmodel (Lambert = faceted voxel look, no fog) */
  const _viewMatCache = {};
  function viewMat(color) {
    const key = color | 0;
    if (_viewMatCache[key]) return _viewMatCache[key];
    const mat = new THREE.MeshLambertMaterial({
      color: key,
      emissive: key,
      emissiveIntensity: 0.12,
    });
    mat.fog = false;
    _viewMatCache[key] = mat;
    return mat;
  }

  function viewBox(w, h, d, color, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), viewMat(color));
    m.position.set(x, y, z);
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }

  /** Paint a volume with a camo voxel pattern (orange / brown / black) */
  function addCamoVolume(parent, x0, y0, z0, nx, ny, nz, cell, colors) {
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          const h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
          const c = colors[(h >>> 0) % colors.length];
          parent.add(
            viewBox(
              cell * 0.96,
              cell * 0.96,
              cell * 0.96,
              c,
              x0 + (ix - (nx - 1) * 0.5) * cell,
              y0 + (iy - (ny - 1) * 0.5) * cell,
              z0 + (iz - (nz - 1) * 0.5) * cell
            )
          );
        }
      }
    }
  }

  /** Checkered sleeve strip for FPS arms */
  function addCheckeredSleeve(parent, x, y, z, len, axis) {
    const a = 0x3a3a38;
    const b = 0x1a1a18;
    const c = 0x5a5a50;
    const cell = 0.045;
    const n = Math.max(2, Math.round(len / cell));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          const col = (i + j + k) % 2 === 0 ? a : (j === 1 ? c : b);
          let px = x;
          let py = y;
          let pz = z;
          if (axis === 'y') {
            px += (j - 1) * cell;
            py += (i - (n - 1) * 0.5) * cell;
            pz += (k - 1) * cell;
          } else {
            px += (j - 1) * cell;
            py += (k - 1) * cell;
            pz += (i - (n - 1) * 0.5) * cell;
          }
          parent.add(viewBox(cell * 0.92, cell * 0.92, cell * 0.92, col, px, py, pz));
        }
      }
    }
  }

  /** Shoulder stubs — forearms/hands are parented to the weapon (addGunArms). */
  function addCombatArms(root, sleeve) {
    sleeve = sleeve != null ? sleeve : PALETTE.olive;
    root.add(box(0.26, 0.26, 0.26, sleeve, -0.48, 1.28, 0.02));
    root.add(box(0.26, 0.26, 0.26, sleeve, 0.48, 1.28, 0.02));
  }

  /**
   * Hip-pivoted legs for MC-style walk swing.
   * Part Y values are in soldier root space; converted to hip-local.
   * @param {object} opts
   * @param {number} [opts.x=0.17] hip half-spacing
   * @param {number} [opts.hipY=0.68]
   * @param {number} opts.thighW,thighH,thighD,thighY
   * @param {number} opts.thighColorL,thighColorR
   * @param {number} [opts.kneeW,kneeH,kneeD,kneeY,kneeColor] optional knee pads
   * @param {number} opts.bootW,bootH,bootD,bootY
   * @param {number} [opts.bootColor]
   */
  function addLegPair(root, opts) {
    const hipY = opts.hipY != null ? opts.hipY : 0.68;
    const hx = opts.x != null ? opts.x : 0.17;
    const bootColor = opts.bootColor != null ? opts.bootColor : PALETTE.boot;

    function makeLeg(side, thighColor) {
      const g = new THREE.Group();
      g.name = side < 0 ? 'LeftLeg' : 'RightLeg';
      g.position.set(side * hx, hipY, 0);
      g.add(
        box(
          opts.thighW,
          opts.thighH,
          opts.thighD,
          thighColor,
          0,
          opts.thighY - hipY,
          opts.thighZ || 0
        )
      );
      if (opts.kneeW != null) {
        g.add(
          box(
            opts.kneeW,
            opts.kneeH,
            opts.kneeD,
            opts.kneeColor,
            0,
            opts.kneeY - hipY,
            opts.kneeZ != null ? opts.kneeZ : 0.02
          )
        );
      }
      g.add(
        box(
          opts.bootW,
          opts.bootH,
          opts.bootD,
          bootColor,
          0,
          opts.bootY - hipY,
          opts.bootZ != null ? opts.bootZ : 0.02
        )
      );
      root.add(g);
      return g;
    }

    makeLeg(-1, opts.thighColorL);
    makeLeg(1, opts.thighColorR);
  }

  function addGun(root, style, muzzleZ) {
    const gun = new THREE.Group();
    gun.name = 'Weapon';
    const g = PALETTE.gun;
    const gd = PALETTE.gunDark;
    const wood = 0x8a5a32;
    const accent = PALETTE.orange;
    const vest = PALETTE.vest;

    if (style === 'heavy') {
      gun.add(box(0.18, 0.18, 0.55, g, 0, 0.02, -0.05));
      gun.add(box(0.14, 0.14, 0.55, gd, 0, 0.02, -0.55));
      gun.add(box(0.1, 0.1, 0.28, gd, 0, 0.02, -0.95));
      gun.add(box(0.16, 0.28, 0.14, gd, 0, -0.16, 0.05));
      gun.add(box(0.2, 0.14, 0.28, wood, 0, 0, 0.32));
      gun.add(box(0.12, 0.12, 0.22, accent, 0, -0.16, -0.2));
      gun.add(box(0.1, 0.1, 0.2, vest, 0, 0.16, -0.1));
      gun.add(box(0.08, 0.08, 0.08, 0x1a1a1a, 0, 0.24, -0.1));
    } else if (style === 'sniper') {
      gun.add(box(0.11, 0.12, 0.7, g, 0, 0.02, -0.15));
      gun.add(box(0.08, 0.08, 0.7, gd, 0, 0.02, -0.8));
      gun.add(box(0.09, 0.2, 0.12, gd, 0, -0.12, 0.05));
      gun.add(box(0.14, 0.12, 0.28, wood, 0, 0, 0.35));
      gun.add(box(0.1, 0.1, 0.28, vest, 0, 0.16, -0.2));
      gun.add(box(0.06, 0.06, 0.1, 0x111111, 0, 0.24, -0.2));
    } else {
      // Assault rifle — full stock → muzzle for third-person / AI
      gun.add(box(0.14, 0.12, 0.26, wood, 0, 0.02, 0.32));
      gun.add(box(0.13, 0.14, 0.5, g, 0, 0.02, -0.05));
      gun.add(box(0.11, 0.08, 0.32, accent, 0, -0.02, -0.05));
      gun.add(box(0.11, 0.11, 0.42, gd, 0, 0.02, -0.48));
      gun.add(box(0.07, 0.07, 0.32, gd, 0, 0.02, -0.85));
      gun.add(box(0.09, 0.09, 0.1, g, 0, 0.02, -1.02));
      gun.add(box(0.1, 0.2, 0.12, gd, 0, -0.12, 0.08));
      gun.add(box(0.12, 0.16, 0.14, accent, 0, -0.16, -0.1));
      gun.add(box(0.09, 0.06, 0.28, gd, 0, 0.12, -0.1));
      gun.add(box(0.1, 0.1, 0.16, vest, 0, 0.18, -0.08));
      gun.add(box(0.06, 0.06, 0.08, 0x222222, 0, 0.26, -0.08));
    }

    // Hands + forearms parented to gun (survive finishSoldier facing wrap)
    const skin = PALETTE.skin;
    const sleeve = PALETTE.olive;
    const glove = PALETTE.glove;
    const rh = new THREE.Group();
    rh.name = 'GunRightHand';
    rh.add(box(0.14, 0.14, 0.14, skin, 0, 0, 0));
    rh.add(box(0.12, 0.1, 0.16, glove, 0, -0.02, 0.02));
    rh.add(box(0.18, 0.18, 0.32, skin, 0.04, 0.02, 0.22));
    rh.add(box(0.2, 0.2, 0.28, sleeve, 0.06, 0.06, 0.48));
    rh.position.set(0.04, -0.18, 0.08);
    rh.rotation.set(0.15, 0.1, -0.2);
    gun.add(rh);

    const lh = new THREE.Group();
    lh.name = 'GunLeftHand';
    lh.add(box(0.13, 0.13, 0.13, skin, 0, 0, 0));
    lh.add(box(0.11, 0.09, 0.14, glove, 0, -0.02, 0.02));
    lh.add(box(0.16, 0.16, 0.36, skin, -0.06, 0.04, 0.2));
    lh.add(box(0.18, 0.18, 0.3, sleeve, -0.1, 0.08, 0.45));
    lh.position.set(-0.04, -0.08, style === 'sniper' ? -0.5 : -0.4);
    lh.rotation.set(0.1, -0.25, 0.35);
    gun.add(lh);

    // Aim-ready: rifle at chest height, barrel forward (-Z)
    gun.position.set(0.18, 1.22, -0.35);
    gun.rotation.set(-0.2, 0.05, 0.08);

    const muzzle = new THREE.Object3D();
    muzzle.name = 'Muzzle';
    muzzle.position.set(0, 0.02, muzzleZ != null ? muzzleZ : -1.05);
    gun.add(muzzle);
    const flash = new THREE.Object3D();
    flash.name = 'MuzzleFlash';
    muzzle.add(flash);
    root.add(gun);
    return { gun, muzzle, flash };
  }

  function addTeamMarker(root, team) {
    const L = global.VF && global.VF.TeamLook;
    const foe = L && L.kind ? L.kind(team) === 'foe' : team === 'enemy';
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.55, 16),
      new THREE.MeshBasicMaterial({
        color: foe ? 0xff3344 : 0x33aaff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
      })
    );
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = 0.05;
    marker.name = 'TeamMarker';
    marker.userData.faction = team;
    root.add(marker);
  }

  function refreshTeamMarker(root, team) {
    if (!root) return;
    const marker = root.getObjectByName('TeamMarker');
    if (!marker || !marker.material || !marker.material.color) return;
    const L = global.VF && global.VF.TeamLook;
    const foe = L && L.kind ? L.kind(team) === 'foe' : team === 'enemy';
    marker.material.color.setHex(foe ? 0xff3344 : 0x33aaff);
    marker.userData.faction = team;
  }

  function finishSoldier(root, classId, team, muzzle, flash) {
    addTeamMarker(root, team);

    // Built face sits on +Z while movement / AI face -Z.
    // Spin body 180° so eyes face look direction; mirror gun pose so it stays in front.
    const wrap = new THREE.Group();
    wrap.name = 'SoldierFacing';
    const kids = root.children.slice();
    for (let i = 0; i < kids.length; i++) wrap.add(kids[i]);
    wrap.rotation.y = Math.PI;
    const gun = wrap.getObjectByName('Weapon');
    if (gun) {
      // Wrap flipped gun to the character's back — mirror position + yaw back to front
      gun.position.x *= -1;
      gun.position.z *= -1;
      gun.rotation.y += Math.PI;
    }
    root.add(wrap);

    // Prevent pop-in/out when clustered or near camera frustum edge
    root.frustumCulled = false;
    root.visible = true;
    root.traverse(function (c) {
      c.frustumCulled = false;
      if (c.isMesh) c.visible = true;
    });

    root.userData.variant = classId;
    root.userData.classId = classId;
    root.userData.team = team;
    root.userData.muzzle = muzzle;
    root.userData.flash = flash;
    initLocomotion(root);
    return root;
  }

  /* ---------- Class builders ---------- */

  function buildVanguard(root, enemyTint) {
    const olive = enemyTint ? PALETTE.enemyRed : PALETTE.olive;
    const oliveDark = enemyTint ? PALETTE.enemyDark : PALETTE.oliveDark;
    const camo = enemyTint ? 0x5a3030 : PALETTE.camo;
    const camoGrey = enemyTint ? 0x4a3838 : PALETTE.camoGrey;
    const vest = enemyTint ? 0x2a1818 : PALETTE.vest;
    const orange = enemyTint ? PALETTE.enemyOrange : PALETTE.orange;

    addLegPair(root, {
      x: 0.17,
      hipY: 0.68,
      thighW: 0.28,
      thighH: 0.55,
      thighD: 0.3,
      thighY: 0.4,
      thighColorL: camo,
      thighColorR: camoGrey,
      kneeW: 0.3,
      kneeH: 0.18,
      kneeD: 0.32,
      kneeY: 0.55,
      kneeColor: vest,
      bootW: 0.3,
      bootH: 0.22,
      bootD: 0.36,
      bootY: 0.11,
    });

    root.add(box(0.72, 0.7, 0.4, camo, 0, 1.05, 0));
    root.add(box(0.76, 0.45, 0.44, vest, 0, 1.15, 0.02));
    root.add(box(0.14, 0.14, 0.1, orange, -0.2, 0.92, 0.24));
    root.add(box(0.14, 0.14, 0.1, orange, 0, 0.92, 0.24));
    root.add(box(0.14, 0.14, 0.1, orange, 0.2, 0.92, 0.24));

    addCombatArms(root, olive, PALETTE.skin);

    root.add(box(0.42, 0.42, 0.42, PALETTE.skin, 0, 1.62, 0));
    root.add(box(0.1, 0.08, 0.06, PALETTE.eye, -0.1, 1.64, 0.2));
    root.add(box(0.1, 0.08, 0.06, PALETTE.eye, 0.1, 1.64, 0.2));
    root.add(box(0.18, 0.06, 0.06, PALETTE.mustache, 0, 1.52, 0.2));

    root.add(box(0.5, 0.28, 0.5, olive, 0, 1.82, 0));
    root.add(box(0.48, 0.12, 0.48, oliveDark, 0, 1.72, 0.02));
    root.add(box(0.16, 0.12, 0.22, vest, 0, 1.78, 0.28));

    root.add(box(0.5, 0.55, 0.28, oliveDark, 0, 1.15, -0.32));
    root.add(box(0.18, 0.18, 0.12, orange, -0.12, 1.28, -0.48));
    root.add(box(0.18, 0.18, 0.12, orange, 0.12, 1.28, -0.48));
    root.add(box(0.18, 0.18, 0.12, orange, -0.12, 1.05, -0.48));
    root.add(box(0.18, 0.18, 0.12, orange, 0.12, 1.05, -0.48));

    const pick = new THREE.Group();
    pick.add(box(0.08, 0.55, 0.08, PALETTE.wood, 0, 0, 0));
    pick.add(box(0.35, 0.1, 0.12, PALETTE.glove, 0.05, 0.28, 0));
    pick.position.set(0.28, 1.35, -0.28);
    pick.rotation.z = -0.4;
    pick.rotation.x = 0.25;
    root.add(pick);

    return addGun(root, 'rifle', -0.85);
  }

  function buildMedic(root, enemyTint) {
    const white = enemyTint ? 0xc8a0a0 : PALETTE.white;
    const whiteDim = enemyTint ? 0xa87878 : PALETTE.whiteDim;
    const olive = enemyTint ? PALETTE.enemyDark : PALETTE.olive;
    const red = PALETTE.redCross;

    addLegPair(root, {
      x: 0.17,
      hipY: 0.68,
      thighW: 0.28,
      thighH: 0.55,
      thighD: 0.3,
      thighY: 0.4,
      thighColorL: whiteDim,
      thighColorR: white,
      kneeW: 0.3,
      kneeH: 0.18,
      kneeD: 0.32,
      kneeY: 0.55,
      kneeColor: olive,
      bootW: 0.3,
      bootH: 0.22,
      bootD: 0.36,
      bootY: 0.11,
    });

    root.add(box(0.7, 0.68, 0.4, white, 0, 1.05, 0));
    root.add(box(0.74, 0.42, 0.44, whiteDim, 0, 1.14, 0.02));
    root.add(box(0.16, 0.16, 0.08, olive, -0.22, 0.95, 0.26));
    root.add(box(0.16, 0.16, 0.08, olive, 0.22, 0.95, 0.26));
    // Shoulder red cross
    root.add(box(0.14, 0.04, 0.04, red, -0.42, 1.28, 0.12));
    root.add(box(0.04, 0.14, 0.04, red, -0.42, 1.28, 0.12));

    addCombatArms(root, white, PALETTE.skinLight);

    root.add(box(0.4, 0.4, 0.4, PALETTE.skinLight, 0, 1.6, 0));
    root.add(box(0.08, 0.07, 0.05, PALETTE.eye, -0.09, 1.62, 0.2));
    root.add(box(0.08, 0.07, 0.05, PALETTE.eye, 0.09, 1.62, 0.2));
    // Blonde hair + ponytail
    root.add(box(0.44, 0.18, 0.44, PALETTE.blonde, 0, 1.78, -0.02));
    root.add(box(0.16, 0.28, 0.16, PALETTE.blonde, 0.18, 1.55, -0.28));
    // Cap + red cross
    root.add(box(0.48, 0.16, 0.48, white, 0, 1.88, 0));
    root.add(box(0.12, 0.04, 0.04, red, 0, 1.92, 0.2));
    root.add(box(0.04, 0.12, 0.04, red, 0, 1.92, 0.2));

    // Med pack
    root.add(box(0.52, 0.58, 0.32, olive, 0, 1.12, -0.34));
    root.add(box(0.28, 0.28, 0.06, white, 0, 1.18, -0.52));
    root.add(box(0.18, 0.05, 0.05, red, 0, 1.18, -0.55));
    root.add(box(0.05, 0.18, 0.05, red, 0, 1.18, -0.55));
    root.add(box(0.14, 0.14, 0.1, white, -0.22, 1.0, -0.5));
    root.add(box(0.08, 0.03, 0.03, red, -0.22, 1.0, -0.56));
    root.add(box(0.03, 0.08, 0.03, red, -0.22, 1.0, -0.56));

    return addGun(root, 'rifle', -0.85);
  }

  function buildGhost(root, enemyTint) {
    const g = enemyTint ? 0x5a3038 : PALETTE.ghillie;
    const gd = enemyTint ? 0x3a1820 : PALETTE.ghillieDark;
    const gb = enemyTint ? 0x4a2820 : PALETTE.ghillieBrown;

    // Shaggy silhouette — many small boxes
    addLegPair(root, {
      x: 0.16,
      hipY: 0.68,
      thighW: 0.32,
      thighH: 0.55,
      thighD: 0.32,
      thighY: 0.4,
      thighColorL: g,
      thighColorR: gd,
      bootW: 0.3,
      bootH: 0.22,
      bootD: 0.34,
      bootY: 0.1,
    });

    root.add(box(0.78, 0.75, 0.5, g, 0, 1.05, 0));
    root.add(box(0.2, 0.2, 0.18, gd, -0.35, 1.35, 0.15));
    root.add(box(0.18, 0.22, 0.16, gb, 0.32, 1.2, 0.18));
    root.add(box(0.22, 0.16, 0.2, gd, -0.1, 1.4, -0.1));
    root.add(box(0.16, 0.2, 0.18, gb, 0.2, 0.9, 0.2));

    addCombatArms(root, g, PALETTE.skin);

    // Hood + face peek
    root.add(box(0.55, 0.5, 0.55, g, 0, 1.7, -0.05));
    root.add(box(0.2, 0.16, 0.12, gd, -0.22, 1.85, 0.1));
    root.add(box(0.18, 0.2, 0.14, gb, 0.2, 1.78, 0.08));
    root.add(box(0.28, 0.28, 0.2, PALETTE.skin, 0, 1.58, 0.18));
    root.add(box(0.08, 0.06, 0.04, 0x111111, -0.07, 1.6, 0.28));
    root.add(box(0.08, 0.06, 0.04, 0x111111, 0.07, 1.6, 0.28));

    // Leafy backpack mound
    root.add(box(0.6, 0.7, 0.4, g, 0, 1.15, -0.35));
    root.add(box(0.22, 0.25, 0.2, gd, -0.2, 1.4, -0.5));
    root.add(box(0.2, 0.22, 0.18, gb, 0.18, 1.25, -0.48));
    root.add(box(0.18, 0.2, 0.16, gd, 0, 1.0, -0.52));

    return addGun(root, 'sniper', -1.15);
  }

  function buildJuggernaut(root, enemyTint) {
    const plate = enemyTint ? 0x4a2020 : PALETTE.plate;
    const charcoal = enemyTint ? 0x2a1010 : PALETTE.charcoal;
    const orange = enemyTint ? PALETTE.enemyOrange : PALETTE.orange;
    root.scale.setScalar(1.12);

    addLegPair(root, {
      x: 0.2,
      hipY: 0.68,
      thighW: 0.36,
      thighH: 0.55,
      thighD: 0.36,
      thighY: 0.4,
      thighColorL: charcoal,
      thighColorR: charcoal,
      kneeW: 0.38,
      kneeH: 0.22,
      kneeD: 0.38,
      kneeY: 0.55,
      kneeColor: plate,
      bootW: 0.36,
      bootH: 0.24,
      bootD: 0.4,
      bootY: 0.1,
    });

    root.add(box(0.9, 0.85, 0.55, charcoal, 0, 1.1, 0));
    root.add(box(0.95, 0.5, 0.58, plate, 0, 1.2, 0.04));
    root.add(box(0.28, 0.2, 0.12, orange, -0.25, 1.0, 0.32));
    root.add(box(0.28, 0.2, 0.12, orange, 0.25, 1.0, 0.32));
    // Shoulder pads
    root.add(box(0.28, 0.22, 0.28, orange, -0.55, 1.35, 0));
    root.add(box(0.28, 0.22, 0.28, orange, 0.55, 1.35, 0));

    addCombatArms(root, plate, PALETTE.skin);

    root.add(box(0.5, 0.45, 0.5, charcoal, 0, 1.7, 0));
    root.add(box(0.52, 0.28, 0.52, plate, 0, 1.88, 0));
    // Orange visor bars
    root.add(box(0.38, 0.08, 0.08, orange, 0, 1.72, 0.26));
    root.add(box(0.3, 0.06, 0.06, orange, 0, 1.82, 0.26));

    root.add(box(0.65, 0.7, 0.4, charcoal, 0, 1.15, -0.4));
    root.add(box(0.22, 0.5, 0.22, orange, -0.18, 1.2, -0.62));
    root.add(box(0.22, 0.5, 0.22, orange, 0.18, 1.2, -0.62));

    return addGun(root, 'heavy', -0.95);
  }

  function buildRaider(root) {
    const vest = PALETTE.vest;
    const camo = PALETTE.camoGrey;
    const red = PALETTE.bandana;

    addLegPair(root, {
      x: 0.17,
      hipY: 0.68,
      thighW: 0.28,
      thighH: 0.55,
      thighD: 0.3,
      thighY: 0.4,
      thighColorL: camo,
      thighColorR: camo,
      kneeW: 0.3,
      kneeH: 0.16,
      kneeD: 0.32,
      kneeY: 0.55,
      kneeColor: vest,
      bootW: 0.3,
      bootH: 0.22,
      bootD: 0.36,
      bootY: 0.11,
    });

    // Sleeveless torso + vest
    root.add(box(0.68, 0.65, 0.38, 0x2a2a28, 0, 1.05, 0));
    root.add(box(0.72, 0.4, 0.42, vest, 0, 1.12, 0.02));
    root.add(box(0.12, 0.12, 0.1, PALETTE.orange, -0.2, 0.95, 0.24));
    root.add(box(0.12, 0.12, 0.1, PALETTE.orange, 0.05, 0.95, 0.24));
    // Bandolier
    root.add(box(0.08, 0.55, 0.12, 0x1a1a18, 0.05, 1.15, 0.18));
    root.add(box(0.1, 0.08, 0.08, 0x444440, 0.05, 1.3, 0.22));
    root.add(box(0.1, 0.08, 0.08, 0x444440, 0.05, 1.1, 0.22));

    // Bare muscular arms in combat hold
    addCombatArms(root, PALETTE.skin, PALETTE.skin);

    root.add(box(0.42, 0.42, 0.42, PALETTE.skin, 0, 1.62, 0));
    root.add(box(0.1, 0.08, 0.06, PALETTE.eye, -0.1, 1.64, 0.2));
    root.add(box(0.1, 0.08, 0.06, PALETTE.eye, 0.1, 1.64, 0.2));
    root.add(box(0.18, 0.06, 0.06, PALETTE.mustache, 0, 1.52, 0.2));
    // Red bandana
    root.add(box(0.5, 0.14, 0.5, red, 0, 1.82, 0));
    root.add(box(0.14, 0.2, 0.1, red, 0.22, 1.72, -0.22));

    root.add(box(0.45, 0.48, 0.28, vest, 0, 1.12, -0.3));
    root.add(box(0.14, 0.14, 0.1, 0x333330, -0.12, 1.2, -0.46));
    root.add(box(0.14, 0.14, 0.1, 0x333330, 0.12, 1.2, -0.46));
    root.add(box(0.08, 0.28, 0.08, PALETTE.gunDark, 0.28, 1.15, -0.35));

    return addGun(root, 'rifle', -0.85);
  }

  function buildEngineer(root, enemyTint) {
    const suit = enemyTint ? PALETTE.enemyDark : PALETTE.oliveDark;
    const orange = enemyTint ? PALETTE.enemyOrange : PALETTE.orange;

    addLegPair(root, {
      x: 0.17,
      hipY: 0.68,
      thighW: 0.28,
      thighH: 0.55,
      thighD: 0.3,
      thighY: 0.4,
      thighColorL: suit,
      thighColorR: suit,
      kneeW: 0.3,
      kneeH: 0.1,
      kneeD: 0.32,
      kneeY: 0.55,
      kneeColor: orange,
      bootW: 0.3,
      bootH: 0.22,
      bootD: 0.36,
      bootY: 0.11,
    });

    root.add(box(0.72, 0.7, 0.42, suit, 0, 1.05, 0));
    root.add(box(0.74, 0.12, 0.44, orange, 0, 1.2, 0.02));
    root.add(box(0.14, 0.14, 0.1, PALETTE.grey, -0.22, 0.92, 0.24));
    root.add(box(0.14, 0.14, 0.1, PALETTE.grey, 0.22, 0.92, 0.24));

    addCombatArms(root, suit, PALETTE.skin);

    root.add(box(0.42, 0.4, 0.42, PALETTE.skin, 0, 1.6, 0));
    // Face / eyes (front = +Z, aligned with other classes)
    root.add(box(0.1, 0.08, 0.06, PALETTE.eye, -0.1, 1.62, 0.2));
    root.add(box(0.1, 0.08, 0.06, PALETTE.eye, 0.1, 1.62, 0.2));
    root.add(box(0.5, 0.32, 0.5, PALETTE.charcoal, 0, 1.82, 0));
    root.add(box(0.36, 0.12, 0.12, orange, 0, 1.78, 0.24));
    root.add(box(0.1, 0.1, 0.08, PALETTE.grey, 0.28, 1.85, 0));

    root.add(box(0.5, 0.55, 0.3, PALETTE.charcoal, 0, 1.12, -0.34));
    root.add(box(0.42, 0.08, 0.08, orange, 0, 1.28, -0.5));
    root.add(box(0.42, 0.08, 0.08, orange, 0, 1.14, -0.5));
    root.add(box(0.42, 0.08, 0.08, orange, 0, 1.0, -0.5));
    // Antenna
    root.add(box(0.06, 0.55, 0.06, PALETTE.grey, 0.22, 1.55, -0.4));
    root.add(box(0.1, 0.08, 0.1, orange, 0.22, 1.85, -0.4));

    return addGun(root, 'rifle', -0.85);
  }

  function resolveFactionTeam(team) {
    if (team === 'enemy' || team === 'ally') return team;
    const g = global.VF && global.VF.game;
    const worldTeam = g && g.world && g.world._playerTeam;
    if (worldTeam === 'enemy' || worldTeam === 'ally') return worldTeam;
    const playerTeam = g && g.player && g.player.team;
    if (playerTeam === 'enemy' || playerTeam === 'ally') return playerTeam;
    return 'ally';
  }

  /**
   * Uniform colors follow the faction id (ally = 蓝, enemy = 红).
   * HUD rings still use TeamLook (friend = blue, foe = red).
   * @param {string} classId
   * @param {{ team?: 'ally'|'enemy' }} opts
   */
  function createClassSoldier(classId, opts) {
    opts = opts || {};
    classId = normalizeClassId(classId);
    const team = opts.team === 'enemy' ? 'enemy' : 'ally';
    const enemyTint = team === 'enemy';
    const root = new THREE.Group();
    root.name = 'Soldier_' + classId;

    let gunBits;
    switch (classId) {
      case 'support':
        gunBits = buildMedic(root, enemyTint);
        break;
      case 'recon':
        gunBits = buildGhost(root, enemyTint);
        break;
      case 'engineer':
        gunBits = buildEngineer(root, enemyTint);
        break;
      case 'assault':
      default:
        gunBits = buildVanguard(root, enemyTint);
        break;
    }

    return finishSoldier(root, classId, team, gunBits.muzzle, gunBits.flash);
  }

  /** AI / legacy variants */
  function createSoldier(variant) {
    if (variant === 'enemy_heavy') {
      return createClassSoldier('juggernaut', { team: 'enemy' });
    }
    if (variant === 'enemy_ranged') {
      return createClassSoldier('ghost', { team: 'enemy' });
    }
    if (variant === 'enemy' || (variant && variant.indexOf('enemy') === 0)) {
      return createClassSoldier('vanguard', { team: 'enemy' });
    }
    if (variant === 'ally' || !variant) {
      return createClassSoldier('vanguard', { team: 'ally' });
    }
    // Treat unknown as class id
    return createClassSoldier(variant, { team: 'ally' });
  }

  /** FPS arms + full rifle — all meshes stay in front of camera (-Z) */
  /** FPS viewmodel — detailed voxel rifle + articulated hands (ref: lower-right hipfire) */
  function createViewModel(classId, weaponId, opts) {
    classId = normalizeClassId(classId);
    opts = opts || {};
    const team = resolveFactionTeam(opts.team);
    const enemyTint = team === 'enemy';
    const pal = viewModelSleeveColors(classId, enemyTint);
    const root = new THREE.Group();
    root.name = 'SoldierViewModel';
    root.frustumCulled = false;
    // Comfortable lower-right hip-fire: moderate size, barrel toward crosshair
    root.position.set(0.3, -0.34, -0.52);

    const skin = pal.skin;
    const skinDark = pal.skinDark;
    const sleeveA = pal.sleeveA;
    const sleeveB = pal.sleeveB;
    let camo = [0xc07028, 0x8a4a20, 0x5a3020, 0x2a2a28, 0xa85820];
    if (classId === 'support') {
      camo = enemyTint
        ? [0xc8a0a0, 0xa87878, 0xd02828, 0x2a2a28, PALETTE.enemyDark]
        : [0xe8e8e8, 0xc8c8c8, 0xd02828, 0x2a2a28, 0x4a5c28];
    } else if (classId === 'recon') {
      camo = enemyTint
        ? [0x5a3038, 0x3a1820, 0x4a2820, 0x2a2a28, 0x1a1a18]
        : [0x4a6a30, 0x3a5020, 0x5a4a28, 0x2a2a28, 0x1a1a18];
    } else if (classId === 'engineer') {
      camo = enemyTint
        ? [PALETTE.enemyDark, PALETTE.enemyOrange, 0x2a2a2e, 0x8a8a8a, 0x1a1a18]
        : [0x2f3d1c, 0xc07028, 0x2a2a2e, 0x8a8a8a, 0x1a1a18];
    } else if (enemyTint) {
      camo = [PALETTE.enemyOrange, PALETTE.enemyRed, PALETTE.enemyDark, 0x2a2a28, 0xa85820];
    }

    const long = classId === 'recon';
    const b = viewBox;
    const weaponDef =
      (weaponId && global.VF.WEAPONS && global.VF.WEAPONS[weaponId]) ||
      (weaponId && global.VF.WEAPON_CATALOG && global.VF.WEAPON_CATALOG[weaponId]) ||
      null;
    let gun;
    let muzzle;
    let flash;
    const useCatalogGun =
      !!(weaponDef && global.VF.WeaponViewModels && global.VF.WeaponViewModels.buildGun);
    if (useCatalogGun) {
      const built = global.VF.WeaponViewModels.buildGun(weaponDef);
      gun = built.gun;
      muzzle = built.muzzle;
      flash = built.flash;
    } else {
      const thick = classId === 'support';
      const dark = 0x1a1e24;
      const mid = 0x2e343c;
      const rail = 0x22262c;
      gun = new THREE.Group();
      gun.name = 'ViewGun';
      gun.frustumCulled = false;

    // ---- Stock (camo voxels) ----
    addCamoVolume(gun, 0.02, 0.02, 0.34, 4, 3, 5, 0.048, camo);
    gun.add(b(0.12, 0.08, 0.1, dark, 0.02, 0.0, 0.18));

    // ---- Receiver body (camo shell + dark internals) ----
    const bodyZ = -0.08;
    addCamoVolume(gun, 0, 0.04, bodyZ, thick ? 5 : 4, thick ? 4 : 3, long ? 12 : 10, 0.045, camo);
    gun.add(b(0.1, 0.06, 0.38, mid, 0.06, -0.02, bodyZ)); // side plate
    gun.add(b(0.08, 0.05, 0.3, dark, -0.06, 0.0, bodyZ));

    // ---- Top rail (segmented Picatinny) ----
    for (let i = 0; i < 10; i++) {
      const z = 0.05 - i * 0.055;
      gun.add(b(0.09, 0.035, 0.03, i % 2 ? rail : dark, 0, 0.13, z));
    }

    // ---- Holographic / red-dot optic ----
    gun.add(b(0.11, 0.04, 0.16, dark, 0, 0.17, -0.02));
    gun.add(b(0.1, 0.1, 0.12, mid, 0, 0.24, -0.02));
    gun.add(b(0.07, 0.07, 0.04, 0x0a0a0a, 0, 0.25, -0.1));
    gun.add(b(0.03, 0.03, 0.02, 0xff4422, 0, 0.25, -0.13));
    gun.add(b(0.02, 0.04, 0.02, 0xffaa44, 0, 0.28, -0.02)); // optic nub

    // ---- Handguard with rail detail ----
    const hgZ = long ? -0.42 : -0.36;
    addCamoVolume(gun, 0, 0.02, hgZ, 3, 3, long ? 8 : 7, 0.042, [camo[0], camo[1], dark, mid, camo[3]]);
    for (let i = 0; i < 6; i++) {
      gun.add(b(0.1, 0.03, 0.028, rail, 0, 0.1, hgZ + 0.12 - i * 0.05));
    }

    // ---- Barrel — about half + comfort length toward crosshair ----
    const barLen = long ? 0.36 : thick ? 0.32 : 0.3;
    const barZ = hgZ - barLen * 0.55;
    gun.add(b(0.055, 0.055, barLen, dark, 0, 0.04, barZ));
    gun.add(b(0.04, 0.04, barLen * 0.7, mid, 0, 0.04, barZ - 0.02));
    const muzZ = barZ - barLen * 0.55;
    gun.add(b(0.08, 0.08, 0.06, mid, 0, 0.04, muzZ));
    gun.add(b(0.06, 0.06, 0.03, dark, 0, 0.04, muzZ - 0.04));
    gun.add(b(0.02, 0.05, 0.02, rail, 0.035, 0.04, muzZ));
    gun.add(b(0.02, 0.05, 0.02, rail, -0.035, 0.04, muzZ));

    // ---- Magazine ----
    addCamoVolume(gun, 0, -0.16, -0.06, 3, 5, 3, 0.04, [camo[0], camo[2], dark]);
    gun.add(b(0.1, 0.04, 0.12, mid, 0, -0.28, -0.06));

    // ---- Pistol grip ----
    gun.add(b(0.09, 0.2, 0.1, dark, 0.03, -0.18, 0.1));
    gun.add(b(0.08, 0.08, 0.09, mid, 0.03, -0.28, 0.1));
    for (let i = 0; i < 3; i++) {
      gun.add(b(0.085, 0.02, 0.09, rail, 0.03, -0.12 - i * 0.05, 0.1));
    }

    // ---- Trigger guard ----
    gun.add(b(0.06, 0.02, 0.1, dark, 0.02, -0.08, 0.02));
    gun.add(b(0.02, 0.08, 0.02, dark, 0.02, -0.12, -0.02));

      muzzle = new THREE.Object3D();
      muzzle.name = 'Muzzle';
      muzzle.position.set(0, 0.04, muzZ - 0.055);
      gun.add(muzzle);
      flash = new THREE.PointLight(0xffaa44, 0, 8);
      flash.name = 'MuzzleFlash';
      muzzle.add(flash);
      gun.position.set(0.05, -0.05, -0.1);
      gun.rotation.set(0.1, 0.16, 0.05);
    }

    // ========== RIGHT HAND (grip) — palm + fingers ==========
    const rHand = new THREE.Group();
    rHand.name = 'ViewRightHand';
    rHand.add(b(0.13, 0.1, 0.12, skin, 0, 0, 0)); // palm
    rHand.add(b(0.12, 0.08, 0.1, skinDark, 0, -0.02, 0.02));
    // fingers wrapped on grip
    rHand.add(b(0.035, 0.09, 0.04, skin, -0.05, -0.08, 0.02));
    rHand.add(b(0.035, 0.1, 0.04, skin, -0.015, -0.09, 0.02));
    rHand.add(b(0.035, 0.1, 0.04, skin, 0.02, -0.09, 0.02));
    rHand.add(b(0.035, 0.08, 0.04, skin, 0.055, -0.07, 0.02));
    rHand.add(b(0.04, 0.04, 0.07, skin, 0.08, 0.02, -0.02)); // thumb
    rHand.add(b(0.035, 0.035, 0.05, skinDark, 0.09, 0.02, -0.06));
    rHand.position.set(0.1, -0.24, 0.1);
    rHand.rotation.set(0.15, 0.2, -0.15);
    gun.add(rHand);

    // ========== LEFT HAND (forend support) ==========
    const lHand = new THREE.Group();
    lHand.name = 'ViewLeftHand';
    lHand.add(b(0.12, 0.09, 0.13, skin, 0, 0, 0));
    lHand.add(b(0.11, 0.07, 0.11, skinDark, 0, -0.02, 0.02));
    lHand.add(b(0.032, 0.08, 0.04, skin, -0.05, -0.07, -0.02));
    lHand.add(b(0.032, 0.09, 0.04, skin, -0.015, -0.08, -0.02));
    lHand.add(b(0.032, 0.09, 0.04, skin, 0.02, -0.08, -0.02));
    lHand.add(b(0.032, 0.07, 0.04, skin, 0.05, -0.06, -0.02));
    lHand.add(b(0.04, 0.04, 0.08, skin, -0.08, 0.02, 0.04)); // thumb
    lHand.add(b(0.035, 0.035, 0.05, skinDark, -0.09, 0.02, 0.08));
    lHand.position.set(-0.08, -0.1, long ? -0.32 : -0.28);
    lHand.rotation.set(0.2, -0.35, 0.4);
    const style = weaponDef && weaponDef.modelStyle;
    const cat = weaponDef && weaponDef.category;
    if (
      style === 'pistol' ||
      style === 'machine-pistol' ||
      style === 'pistol-heavy' ||
      style === 'revolver' ||
      style === 'revolver-heavy' ||
      cat === 'pistol'
    ) {
      lHand.visible = false;
    } else if (style === 'rpg') {
      lHand.position.set(-0.08, -0.06, -0.2);
    } else if (style === 'shotgun' || cat === 'smg') {
      lHand.position.set(-0.08, -0.1, -0.22);
    } else if (style && style.indexOf('sniper') === 0) {
      lHand.position.set(-0.08, -0.1, -0.36);
    }
    gun.add(lHand);

    root.add(gun);

    // ========== RIGHT ARM (sleeve + forearm → grip) ==========
    const arm = new THREE.Group();
    arm.name = 'ViewRightArm';
    arm.frustumCulled = false;
    addCheckeredSleeve(arm, 0, 0.06, 0, 0.22, 'y');
    arm.add(b(0.14, 0.06, 0.14, sleeveA, 0, 0.16, 0));
    arm.add(b(0.13, 0.16, 0.13, skin, 0.01, -0.12, 0.03));
    arm.add(b(0.12, 0.08, 0.12, skinDark, 0.01, -0.22, 0.04));
    arm.position.set(0.22, -0.1, 0.1);
    arm.rotation.set(0.72, 0.08, -0.42);
    root.add(arm);

    // ========== LEFT ARM (across body → forend) ==========
    const lArm = new THREE.Group();
    lArm.name = 'ViewLeftArm';
    lArm.frustumCulled = false;
    addCheckeredSleeve(lArm, 0, 0.04, 0, 0.2, 'y');
    lArm.add(b(0.13, 0.05, 0.13, sleeveB, 0, 0.14, 0));
    lArm.add(b(0.12, 0.15, 0.12, skin, -0.01, -0.12, 0.04));
    lArm.add(b(0.11, 0.07, 0.11, skinDark, -0.01, -0.22, 0.05));
    lArm.position.set(-0.14, -0.14, -0.18);
    lArm.rotation.set(0.95, 0.32, 0.48);
    root.add(lArm);

    root.userData.classId = classId;
    root.userData.team = team;
    return { root, gun, muzzle, flash, rightArm: arm, leftArm: lArm };
  }

  function viewModelSleeveColors(classId, enemyTint) {
    let skin = PALETTE.skin;
    let skinDark = 0xa88860;
    let sleeveA = enemyTint ? PALETTE.enemyRed : 0x4a5c28;
    let sleeveB = enemyTint ? PALETTE.enemyDark : 0x2f3d1c;
    if (classId === 'medic' || classId === 'support') {
      skin = PALETTE.skinLight;
      skinDark = 0xc4a882;
      sleeveA = enemyTint ? 0xc8a0a0 : 0xe8e8e8;
      sleeveB = enemyTint ? 0xa07070 : 0xc8c8c8;
    } else if (classId === 'ghost' || classId === 'recon') {
      sleeveA = enemyTint ? 0x5a3038 : PALETTE.ghillie;
      sleeveB = enemyTint ? 0x3a1820 : PALETTE.ghillieDark;
    } else if (classId === 'juggernaut') {
      sleeveA = enemyTint ? 0x4a2020 : PALETTE.plate;
      sleeveB = enemyTint ? PALETTE.enemyDark : PALETTE.charcoal;
    } else if (classId === 'raider') {
      sleeveA = skin;
      sleeveB = skinDark;
    } else if (classId === 'engineer') {
      sleeveA = enemyTint ? PALETTE.enemyDark : PALETTE.oliveDark;
      sleeveB = enemyTint ? 0x1a0808 : PALETTE.charcoal;
    }
    return { skin: skin, skinDark: skinDark, sleeveA: sleeveA, sleeveB: sleeveB };
  }

  /**
   * FPS combat knife: right fist on the handle, forearm from lower-right,
   * blade toward the crosshair. Left fist stays in a ready guard.
   */
  function createKnifeViewModel(classId, opts) {
    classId = classId || 'assault';
    const team = resolveFactionTeam(opts && opts.team);
    const pal = viewModelSleeveColors(classId, team === 'enemy');
    const b = viewBox;
    const skin = pal.skin;
    const skinDark = pal.skinDark;
    const sleeveA = pal.sleeveA;
    const sleeveB = pal.sleeveB;

    const root = new THREE.Group();
    root.name = 'ViewKnife';
    root.frustumCulled = false;

    const slash = new THREE.Group();
    slash.name = 'ViewKnifeSlash';
    slash.frustumCulled = false;

    // ---- Blade + handle (local Z = blade forward) ----
    const blade = new THREE.Group();
    blade.name = 'ViewKnifeBlade';
    blade.add(b(0.042, 0.048, 0.16, 0x5a3a22, 0, 0, 0.05));
    blade.add(b(0.036, 0.04, 0.045, 0x3a2418, 0, 0, 0.14));
    blade.add(b(0.1, 0.022, 0.032, 0x2a2a2a, 0, 0, -0.04));
    blade.add(b(0.03, 0.078, 0.26, 0xc8cdd4, 0, 0.01, -0.18));
    blade.add(b(0.02, 0.048, 0.1, 0xe8eef4, 0, 0.018, -0.34));
    blade.add(b(0.014, 0.028, 0.05, 0xf4f7fa, 0, 0.02, -0.4));

    // ---- Right fist wrapping the handle ----
    const rHand = new THREE.Group();
    rHand.name = 'ViewKnifeHand';
    rHand.add(b(0.13, 0.1, 0.12, skin, 0.01, -0.01, 0.04));
    rHand.add(b(0.12, 0.08, 0.1, skinDark, 0.01, -0.03, 0.05));
    rHand.add(b(0.038, 0.09, 0.042, skin, -0.05, -0.08, 0.03));
    rHand.add(b(0.038, 0.1, 0.042, skin, -0.012, -0.09, 0.03));
    rHand.add(b(0.038, 0.1, 0.042, skin, 0.026, -0.09, 0.03));
    rHand.add(b(0.038, 0.08, 0.042, skin, 0.062, -0.07, 0.03));
    rHand.add(b(0.042, 0.042, 0.07, skin, 0.08, 0.03, -0.01));
    rHand.add(b(0.036, 0.036, 0.05, skinDark, 0.09, 0.03, -0.05));
    blade.position.set(0.01, 0.03, -0.02);
    blade.rotation.set(-0.12, 0.08, 0.18);
    rHand.add(blade);

    // ---- Right forearm from lower-right into the fist ----
    const arm = new THREE.Group();
    arm.name = 'ViewKnifeArm';
    arm.frustumCulled = false;
    addCheckeredSleeve(arm, 0, 0.08, 0, 0.22, 'y');
    arm.add(b(0.14, 0.06, 0.14, sleeveA, 0, 0.18, 0));
    arm.add(b(0.13, 0.16, 0.13, skin, 0.01, -0.1, 0.03));
    arm.add(b(0.12, 0.08, 0.12, skinDark, 0.01, -0.2, 0.04));
    arm.position.set(0.16, -0.16, 0.14);
    arm.rotation.set(0.62, 0.12, -0.48);

    rHand.position.set(0.12, -0.12, -0.14);
    rHand.rotation.set(0.18, 0.28, 0.38);

    slash.add(arm);
    slash.add(rHand);

    // ---- Left fist, ready / guard (no blade) ----
    const lArm = new THREE.Group();
    lArm.name = 'ViewKnifeLeftArm';
    lArm.frustumCulled = false;
    addCheckeredSleeve(lArm, 0, 0.04, 0, 0.18, 'y');
    lArm.add(b(0.13, 0.05, 0.13, sleeveB, 0, 0.13, 0));
    lArm.add(b(0.12, 0.14, 0.12, skin, -0.01, -0.1, 0.04));
    lArm.add(b(0.11, 0.08, 0.11, skinDark, -0.01, -0.2, 0.05));
    lArm.add(b(0.1, 0.08, 0.1, skin, -0.02, -0.28, 0.06));
    lArm.add(b(0.032, 0.07, 0.035, skin, -0.06, -0.34, 0.04));
    lArm.add(b(0.032, 0.07, 0.035, skin, -0.02, -0.35, 0.04));
    lArm.add(b(0.032, 0.06, 0.035, skin, 0.02, -0.33, 0.04));
    lArm.position.set(-0.16, -0.2, -0.02);
    lArm.rotation.set(0.95, 0.38, 0.52);

    root.add(slash);
    root.add(lArm);
    root.userData.classId = classId;
    root.userData.team = team;
    root.userData.slash = slash;
    root.userData.rest = {
      x: slash.position.x,
      y: slash.position.y,
      z: slash.position.z,
      rx: slash.rotation.x,
      ry: slash.rotation.y,
      rz: slash.rotation.z,
    };
    return root;
  }

  /**
   * FPS lethal/tactical: camera-space viewmodel in the lower-right, same
   * occupancy as the rifle. Throwables.js animates the root through
   * draw / cook / throw — the nade must stay on-screen while charging.
   */
  function createThrowableViewModel(classId, opts) {
    classId = classId || 'assault';
    const team = resolveFactionTeam(opts && opts.team);
    const pal = viewModelSleeveColors(classId, team === 'enemy');
    const b = viewBox;
    const skin = pal.skin;
    const skinDark = pal.skinDark;
    const sleeveA = pal.sleeveA;
    const sleeveB = pal.sleeveB;

    const root = new THREE.Group();
    root.name = 'ViewThrowable';
    root.frustumCulled = false;
    root.position.set(0.2, -0.22, -0.44);

    const rig = new THREE.Group();
    rig.name = 'ViewThrowRig';
    rig.frustumCulled = false;

    const item = new THREE.Group();
    item.name = 'ViewThrowItem';
    item.frustumCulled = false;

    const grenade = new THREE.Group();
    grenade.name = 'ViewThrowGrenade';
    const body = b(0.17, 0.22, 0.17, 0x4a5a3a, 0, 0, 0);
    body.name = 'ViewThrowBody';
    body.material = new THREE.MeshLambertMaterial({
      color: 0x4a5a3a,
      emissive: 0x1a2014,
      emissiveIntensity: 0.22,
    });
    grenade.add(body);
    grenade.add(b(0.12, 0.05, 0.12, 0x2a2a2a, 0, 0.12, 0));
    grenade.add(b(0.045, 0.09, 0.045, 0x3a3a3a, 0.08, 0.1, 0.02));
    grenade.add(b(0.035, 0.12, 0.025, 0xc8c070, 0.1, 0.02, 0.04));
    item.add(grenade);

    const bottle = new THREE.Group();
    bottle.name = 'ViewThrowBottle';
    bottle.visible = false;
    bottle.add(b(0.1, 0.26, 0.1, 0xcc6622, 0, -0.02, 0));
    bottle.add(b(0.06, 0.1, 0.06, 0x8a4420, 0, 0.14, 0));
    bottle.add(b(0.08, 0.04, 0.08, 0xe8d8a8, 0, 0.2, 0));
    item.add(bottle);

    const can = new THREE.Group();
    can.name = 'ViewThrowCan';
    can.visible = false;
    can.add(b(0.12, 0.2, 0.12, 0xe8e0c8, 0, 0, 0));
    can.add(b(0.1, 0.04, 0.1, 0x888888, 0, 0.11, 0));
    item.add(can);

    function uniquifyMats(obj) {
      obj.traverse(function (m) {
        if (m.material) m.material = m.material.clone();
      });
    }
    uniquifyMats(bottle);
    uniquifyMats(can);

    const rHand = new THREE.Group();
    rHand.frustumCulled = false;
    rHand.add(b(0.16, 0.12, 0.15, skin, 0.03, -0.02, 0.02));
    rHand.add(b(0.14, 0.1, 0.13, skinDark, 0.03, -0.04, 0.04));
    rHand.add(b(0.045, 0.11, 0.05, skin, -0.04, -0.11, 0.02));
    rHand.add(b(0.045, 0.12, 0.05, skin, 0.01, -0.12, 0.02));
    rHand.add(b(0.045, 0.12, 0.05, skin, 0.06, -0.12, 0.02));
    rHand.add(b(0.045, 0.1, 0.05, skin, 0.11, -0.1, 0.02));
    rHand.add(b(0.055, 0.05, 0.09, skin, 0.12, 0.04, -0.04));
    item.position.set(0.04, 0.02, -0.14);
    rHand.add(item);
    rHand.position.set(0.06, -0.1, -0.1);
    rHand.rotation.set(0.18, 0.22, 0.12);

    const rArm = new THREE.Group();
    rArm.frustumCulled = false;
    addCheckeredSleeve(rArm, 0, 0.1, 0, 0.24, 'y');
    rArm.add(b(0.17, 0.07, 0.17, sleeveA, 0, 0.22, 0));
    rArm.add(b(0.15, 0.2, 0.15, skin, 0.01, -0.08, 0.03));
    rArm.add(b(0.14, 0.1, 0.14, skinDark, 0.01, -0.22, 0.04));
    rArm.position.set(0.1, -0.08, 0.08);
    rArm.rotation.set(0.48, 0.08, -0.32);
    rArm.add(rHand);

    const lHand = new THREE.Group();
    lHand.frustumCulled = false;
    lHand.add(b(0.13, 0.1, 0.13, skin, 0, 0, 0));
    lHand.add(b(0.12, 0.08, 0.11, skinDark, 0, -0.02, 0.02));
    lHand.add(b(0.038, 0.09, 0.042, skin, -0.055, -0.09, 0));
    lHand.add(b(0.038, 0.1, 0.042, skin, -0.015, -0.1, 0));
    lHand.add(b(0.038, 0.09, 0.042, skin, 0.025, -0.09, 0));
    lHand.add(b(0.045, 0.045, 0.07, skin, -0.08, 0.03, 0.03));
    lHand.position.set(-0.08, -0.04, -0.18);
    lHand.rotation.set(0.32, -0.18, 0.38);

    const lArm = new THREE.Group();
    lArm.frustumCulled = false;
    addCheckeredSleeve(lArm, 0, 0.06, 0, 0.2, 'y');
    lArm.add(b(0.15, 0.06, 0.15, sleeveB, 0, 0.16, 0));
    lArm.add(b(0.13, 0.16, 0.13, skin, -0.01, -0.1, 0.04));
    lArm.add(b(0.12, 0.09, 0.12, skinDark, -0.01, -0.22, 0.05));
    lArm.position.set(-0.12, -0.14, 0.02);
    lArm.rotation.set(0.78, 0.22, 0.38);
    lArm.add(lHand);

    rig.add(rArm);
    rig.add(lArm);
    lArm.visible = false;
    root.add(rig);
    root.userData.classId = classId;
    root.userData.team = team;
    root.userData.rig = rig;
    root.userData.arm = rig;
    root.userData.rArm = rArm;
    root.userData.lArm = lArm;
    root.userData.item = item;
    root.userData.body = body;
    root.userData.parts = { grenade: grenade, bottle: bottle, can: can };
    root.userData.hip = { x: 0.2, y: -0.22, z: -0.44, rx: 0, ry: 0, rz: 0 };
    root.userData.rArmRest = {
      x: rArm.position.x,
      y: rArm.position.y,
      z: rArm.position.z,
      rx: rArm.rotation.x,
      ry: rArm.rotation.y,
      rz: rArm.rotation.z,
    };
    root.userData.lArmRest = {
      x: lArm.position.x,
      y: lArm.position.y,
      z: lArm.position.z,
      rx: lArm.rotation.x,
      ry: lArm.rotation.y,
      rz: lArm.rotation.z,
    };
    root.userData.rest = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
    return root;
  }

  function capturePose(obj) {
    return {
      x: obj.position.x,
      y: obj.position.y,
      z: obj.position.z,
      rx: obj.rotation.x,
      ry: obj.rotation.y,
      rz: obj.rotation.z,
    };
  }

  /**
   * FPS gadgets (slots 3/4): arms + held crate / C4 / detonator / binoculars.
   * styleGadgetViewModel() swaps the item without rebuilding sleeves.
   */
  function createGadgetViewModel(classId, opts) {
    classId = classId || 'assault';
    const team = resolveFactionTeam(opts && opts.team);
    const pal = viewModelSleeveColors(classId, team === 'enemy');
    const b = viewBox;
    const skin = pal.skin;
    const skinDark = pal.skinDark;
    const sleeveA = pal.sleeveA;
    const sleeveB = pal.sleeveB;

    const root = new THREE.Group();
    root.name = 'ViewGadget';
    root.frustumCulled = false;
    root.position.set(0.2, -0.22, -0.44);

    const rig = new THREE.Group();
    rig.name = 'ViewGadgetRig';
    rig.frustumCulled = false;

    const item = new THREE.Group();
    item.name = 'ViewGadgetItem';
    item.frustumCulled = false;

    const medkit = new THREE.Group();
    medkit.name = 'ViewGadgetMedkit';
    medkit.add(b(0.46, 0.24, 0.34, 0xe8e4dc, 0, 0, 0));
    medkit.add(b(0.44, 0.07, 0.32, 0xd0ccc4, 0, 0.14, 0));
    medkit.add(b(0.44, 0.03, 0.32, 0xc8c4bc, 0, -0.12, 0));
    medkit.add(b(0.26, 0.045, 0.07, 0xc42828, 0, 0.19, 0));
    medkit.add(b(0.07, 0.045, 0.26, 0xc42828, 0, 0.19, 0));
    medkit.add(b(0.07, 0.1, 0.06, 0x8a8a82, -0.18, 0.02, 0.16));
    medkit.add(b(0.07, 0.1, 0.06, 0x8a8a82, 0.18, 0.02, 0.16));
    item.add(medkit);

    const ammo = new THREE.Group();
    ammo.name = 'ViewGadgetAmmo';
    ammo.visible = false;
    ammo.add(b(0.52, 0.28, 0.38, 0x6b5a32, 0, 0, 0));
    ammo.add(b(0.5, 0.07, 0.36, 0x4a3e24, 0, 0.16, 0));
    ammo.add(b(0.18, 0.05, 0.3, 0xc8a040, 0, 0.21, 0));
    ammo.add(b(0.07, 0.12, 0.07, 0x2a2a22, -0.2, 0.02, 0.17));
    ammo.add(b(0.07, 0.12, 0.07, 0x2a2a22, 0.2, 0.02, 0.17));
    ammo.add(b(0.5, 0.03, 0.04, 0x3a3220, 0, -0.08, 0.18));
    item.add(ammo);

    const charge = new THREE.Group();
    charge.name = 'ViewGadgetCharge';
    charge.visible = false;
    charge.add(b(0.16, 0.07, 0.12, 0x3b3027, 0, 0, 0));
    charge.add(b(0.14, 0.03, 0.1, 0x2a221c, 0, 0.04, 0));
    charge.add(b(0.035, 0.025, 0.04, 0x1a8a3a, -0.04, 0.055, 0.02));
    charge.add(b(0.03, 0.02, 0.03, 0xc42828, 0.05, 0.055, 0.02));
    charge.add(b(0.12, 0.015, 0.02, 0x888070, 0, 0.01, 0.06));
    item.add(charge);

    const remote = new THREE.Group();
    remote.name = 'ViewGadgetRemote';
    remote.visible = false;
    remote.add(b(0.08, 0.12, 0.04, 0x2a2e32, 0, 0, 0));
    remote.add(b(0.06, 0.04, 0.03, 0x1a1c1e, 0, 0.03, 0.01));
    remote.add(b(0.03, 0.025, 0.025, 0xc42828, 0, 0.02, 0.02));
    remote.add(b(0.018, 0.14, 0.018, 0x3a3a3a, 0.03, 0.12, 0));
    remote.add(b(0.028, 0.028, 0.028, 0xc8a040, 0.03, 0.2, 0));
    item.add(remote);

    const binoculars = new THREE.Group();
    binoculars.name = 'ViewGadgetBinoculars';
    binoculars.visible = false;
    binoculars.add(b(0.08, 0.08, 0.18, 0x2a2e32, -0.055, 0, 0));
    binoculars.add(b(0.08, 0.08, 0.18, 0x2a2e32, 0.055, 0, 0));
    binoculars.add(b(0.14, 0.04, 0.05, 0x1a1c1e, 0, 0, 0.02));
    binoculars.add(b(0.07, 0.07, 0.04, 0x111318, -0.055, 0, -0.1));
    binoculars.add(b(0.07, 0.07, 0.04, 0x111318, 0.055, 0, -0.1));
    binoculars.add(b(0.055, 0.055, 0.03, 0x3a4048, -0.055, 0, 0.1));
    binoculars.add(b(0.055, 0.055, 0.03, 0x3a4048, 0.055, 0, 0.1));
    item.add(binoculars);

    const rHand = new THREE.Group();
    rHand.frustumCulled = false;
    rHand.add(b(0.16, 0.12, 0.15, skin, 0.03, -0.02, 0.02));
    rHand.add(b(0.14, 0.1, 0.13, skinDark, 0.03, -0.04, 0.04));
    rHand.add(b(0.045, 0.11, 0.05, skin, -0.04, -0.11, 0.02));
    rHand.add(b(0.045, 0.12, 0.05, skin, 0.01, -0.12, 0.02));
    rHand.add(b(0.045, 0.12, 0.05, skin, 0.06, -0.12, 0.02));
    rHand.add(b(0.045, 0.1, 0.05, skin, 0.11, -0.1, 0.02));
    rHand.add(b(0.055, 0.05, 0.09, skin, 0.12, 0.04, -0.04));
    item.position.set(0.04, 0.02, -0.14);
    rHand.add(item);
    rHand.position.set(0.06, -0.1, -0.1);
    rHand.rotation.set(0.18, 0.22, 0.12);

    const rArm = new THREE.Group();
    rArm.frustumCulled = false;
    addCheckeredSleeve(rArm, 0, 0.1, 0, 0.24, 'y');
    rArm.add(b(0.17, 0.07, 0.17, sleeveA, 0, 0.22, 0));
    rArm.add(b(0.15, 0.2, 0.15, skin, 0.01, -0.08, 0.03));
    rArm.add(b(0.14, 0.1, 0.14, skinDark, 0.01, -0.22, 0.04));
    rArm.position.set(0.1, -0.08, 0.08);
    rArm.rotation.set(0.48, 0.08, -0.32);
    rArm.add(rHand);

    const lHand = new THREE.Group();
    lHand.frustumCulled = false;
    lHand.add(b(0.13, 0.1, 0.13, skin, 0, 0, 0));
    lHand.add(b(0.12, 0.08, 0.11, skinDark, 0, -0.02, 0.02));
    lHand.add(b(0.038, 0.09, 0.042, skin, -0.055, -0.09, 0));
    lHand.add(b(0.038, 0.1, 0.042, skin, -0.015, -0.1, 0));
    lHand.add(b(0.038, 0.09, 0.042, skin, 0.025, -0.09, 0));
    lHand.add(b(0.045, 0.045, 0.07, skin, -0.08, 0.03, 0.03));
    lHand.position.set(-0.08, -0.04, -0.18);
    lHand.rotation.set(0.32, -0.18, 0.38);

    const lArm = new THREE.Group();
    lArm.frustumCulled = false;
    addCheckeredSleeve(lArm, 0, 0.06, 0, 0.2, 'y');
    lArm.add(b(0.15, 0.06, 0.15, sleeveB, 0, 0.16, 0));
    lArm.add(b(0.13, 0.16, 0.13, skin, -0.01, -0.1, 0.04));
    lArm.add(b(0.12, 0.09, 0.12, skinDark, -0.01, -0.22, 0.05));
    lArm.position.set(-0.12, -0.14, 0.02);
    lArm.rotation.set(0.78, 0.22, 0.38);
    lArm.add(lHand);

    rig.add(rArm);
    rig.add(lArm);
    root.add(rig);
    root.userData.classId = classId;
    root.userData.team = team;
    root.userData.rig = rig;
    root.userData.arm = rig;
    root.userData.rArm = rArm;
    root.userData.lArm = lArm;
    root.userData.lHand = lHand;
    root.userData.item = item;
    root.userData.parts = {
      medkit: medkit,
      ammo: ammo,
      charge: charge,
      remote: remote,
      binoculars: binoculars,
    };
    root.userData.hip = { x: 0.2, y: -0.22, z: -0.44, rx: 0.04, ry: 0.08, rz: 0.02 };
    root.userData.hipOne = { x: 0.2, y: -0.22, z: -0.44, rx: 0.04, ry: 0.08, rz: 0.02 };
    root.userData.hipCarry = { x: 0.02, y: -0.26, z: -0.5, rx: 0.16, ry: 0, rz: 0 };
    root.userData.ads = { x: 0.0, y: -0.05, z: -0.28, rx: 0.08, ry: 0, rz: 0 };
    root.userData.rArmRest = capturePose(rArm);
    root.userData.lArmRest = capturePose(lArm);
    root.userData.rArmOne = capturePose(rArm);
    root.userData.lArmOne = capturePose(lArm);
    root.userData.rArmCarry = {
      x: 0.12,
      y: -0.12,
      z: 0.0,
      rx: 0.82,
      ry: 0.22,
      rz: -0.38,
    };
    root.userData.lArmCarry = {
      x: -0.04,
      y: -0.14,
      z: -0.08,
      rx: 0.98,
      ry: -0.18,
      rz: 0.52,
    };
    root.userData.lArmTwo = {
      x: -0.08,
      y: -0.08,
      z: -0.04,
      rx: 0.62,
      ry: 0.12,
      rz: 0.28,
    };
    root.userData.visualId = 'medkit';
    return root;
  }

  function styleGadgetViewModel(root, visualId) {
    if (!root) return;
    const parts = root.userData.parts || {};
    const id = visualId || 'empty';
    root.userData.visualId = id;
    const keys = ['medkit', 'ammo', 'charge', 'remote', 'binoculars'];
    for (let i = 0; i < keys.length; i++) {
      if (parts[keys[i]]) parts[keys[i]].visible = keys[i] === id;
    }
    if (root.userData.item) root.userData.item.visible = id !== 'empty';
    const item = root.userData.item;
    const carry = id === 'ammo' || id === 'medkit';
    const twoHand = carry || id === 'binoculars';
    if (item) {
      item.rotation.set(0, 0, 0);
      if (id === 'ammo' || id === 'medkit') {
        item.position.set(-0.16, 0.12, -0.2);
        item.rotation.set(0.18, 0.42, 0.08);
      } else if (id === 'binoculars') item.position.set(0.0, 0.1, -0.2);
      else if (id === 'remote') item.position.set(0.03, 0.04, -0.08);
      else if (id === 'charge') item.position.set(0.04, 0.02, -0.1);
      else item.position.set(0.04, 0.02, -0.14);
    }
    const hip = carry ? root.userData.hipCarry : root.userData.hipOne;
    if (hip) {
      root.userData.hip = {
        x: hip.x,
        y: hip.y,
        z: hip.z,
        rx: hip.rx,
        ry: hip.ry,
        rz: hip.rz,
      };
    }
    const rArm = root.userData.rArm;
    const lArm = root.userData.lArm;
    const rPose = carry ? root.userData.rArmCarry : root.userData.rArmOne;
    const lPose = carry
      ? root.userData.lArmCarry
      : twoHand
        ? root.userData.lArmTwo
        : root.userData.lArmOne;
    if (rArm && rPose) {
      rArm.position.set(rPose.x, rPose.y, rPose.z);
      rArm.rotation.set(rPose.rx, rPose.ry, rPose.rz);
      root.userData.rArmRest = {
        x: rPose.x,
        y: rPose.y,
        z: rPose.z,
        rx: rPose.rx,
        ry: rPose.ry,
        rz: rPose.rz,
      };
    }
    if (lArm && lPose) {
      lArm.visible = true;
      lArm.position.set(lPose.x, lPose.y, lPose.z);
      lArm.rotation.set(lPose.rx, lPose.ry, lPose.rz);
      root.userData.lArmRest = {
        x: lPose.x,
        y: lPose.y,
        z: lPose.z,
        rx: lPose.rx,
        ry: lPose.ry,
        rz: lPose.rz,
      };
    }
  }

  /**
   * FPS held gray stone cube (hotbar 4 / 5 build mode).
   * Shades of gray voxels form one solid block; replaces the rifle viewmodel.
   */
  function createBuildViewModel() {
    const root = new THREE.Group();
    root.name = 'BuildViewModel';
    root.frustumCulled = false;
    root.position.set(0.34, -0.38, -0.52);

    const b = viewBox;
    const skin = PALETTE.skin;
    const skinDark = 0xa88860;

    // Gray shades only — light to dark stone
    const grays = [
      0xd0d0d0, 0xb8b8b8, 0xa0a0a0, 0x888888, 0x707070, 0x585858, 0x404040, 0x2e2e2e,
      0xc4c4c4, 0x9a9a9a, 0x6e6e6e, 0x4a4a4a, 0x949494, 0x7a7a7a, 0x525252, 0x363636,
    ];

    const held = new THREE.Group();
    held.name = 'ViewGun';
    held.frustumCulled = false;

    // One cube made of a 4×4×4 gray voxel grid
    const n = 4;
    const cell = 0.1;
    const origin = -((n - 1) * cell) * 0.5;
    for (let ix = 0; ix < n; ix++) {
      for (let iy = 0; iy < n; iy++) {
        for (let iz = 0; iz < n; iz++) {
          const h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
          const c = grays[(h >>> 0) % grays.length];
          // Slightly darker on lower / back faces for depth
          let col = c;
          if (iy === 0) col = grays[Math.min(grays.length - 1, ((h >>> 0) % grays.length) + 2)];
          if (iy === n - 1) col = grays[(h >>> 0) % 6];
          held.add(
            b(
              cell * 0.96,
              cell * 0.96,
              cell * 0.96,
              col,
              origin + ix * cell,
              origin + iy * cell,
              origin + iz * cell
            )
          );
        }
      }
    }

    held.position.set(0.02, 0.02, -0.1);
    held.rotation.set(0.2, 0.4, 0.08);
    root.add(held);

    // Right hand under / around the stone cube
    const arm = new THREE.Group();
    arm.name = 'ViewRightArm';
    arm.frustumCulled = false;
    arm.add(b(0.14, 0.2, 0.14, 0x3a3a38, 0, 0.05, 0));
    arm.add(b(0.12, 0.14, 0.12, skin, 0.02, -0.12, 0.04));
    arm.add(b(0.13, 0.1, 0.13, skin, 0.04, -0.24, 0.08));
    arm.add(b(0.04, 0.08, 0.04, skin, 0.0, -0.3, 0.04));
    arm.add(b(0.04, 0.08, 0.04, skin, 0.05, -0.3, 0.04));
    arm.add(b(0.04, 0.08, 0.04, skin, 0.1, -0.28, 0.04));
    arm.position.set(0.2, -0.08, 0.1);
    arm.rotation.set(0.7, 0.1, -0.4);
    root.add(arm);

    // Left hand supporting from left
    const lArm = new THREE.Group();
    lArm.name = 'ViewLeftArm';
    lArm.frustumCulled = false;
    lArm.add(b(0.13, 0.18, 0.13, 0x2f3d1c, 0, 0.04, 0));
    lArm.add(b(0.11, 0.13, 0.11, skin, -0.02, -0.12, 0.04));
    lArm.add(b(0.12, 0.09, 0.12, skin, -0.04, -0.22, 0.06));
    lArm.add(b(0.035, 0.07, 0.035, skin, -0.08, -0.28, 0.02));
    lArm.add(b(0.035, 0.07, 0.035, skin, -0.03, -0.28, 0.02));
    lArm.add(b(0.035, 0.07, 0.035, skin, 0.02, -0.26, 0.02));
    lArm.position.set(-0.14, -0.1, -0.12);
    lArm.rotation.set(0.95, 0.35, 0.5);
    root.add(lArm);

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.1, -0.25);
    held.add(muzzle);

    return { root, gun: held, muzzle, flash: null, rightArm: arm, leftArm: lArm };
  }

  /**
   * Third-person crouch pose (0..1). Scales body down from feet; gun follows.
   * Call updateCrouchPose each frame for smooth blend.
   * Prefer after updateLocomotion so gun bob + crouch stack from loco rest.
   */
  function setCrouchPose(root, crouched, flags) {
    flags = flags || {};
    const prone =
      crouched && typeof crouched === 'object' ? !!crouched.prone : !!flags.prone;
    const slide =
      crouched && typeof crouched === 'object' ? !!crouched.slide : !!flags.slide;
    const crouchOn =
      crouched && typeof crouched === 'object'
        ? !!crouched.crouch || prone || slide
        : !!crouched || prone || slide;
    if (!root) return;
    if (!root.userData.crouchPose) {
      root.userData.crouchPose = { target: 0, current: 0 };
    }
    if (!root.userData.pronePose) {
      root.userData.pronePose = { target: 0, current: 0 };
    }
    if (!root.userData.slidePose) {
      root.userData.slidePose = { target: 0, current: 0 };
    }
    root.userData.crouchPose.target = crouchOn ? 1 : 0;
    root.userData.pronePose.target = prone ? 1 : 0;
    root.userData.slidePose.target = slide ? 1 : 0;
  }

  function updateCrouchPose(root, dt) {
    if (!root) return;
    const k = Math.min(1, (dt || 0.016) * 12);
    if (root.userData.crouchPose) {
      const pose = root.userData.crouchPose;
      pose.current += (pose.target - pose.current) * k;
    }
    if (root.userData.pronePose) {
      const pose = root.userData.pronePose;
      pose.current += (pose.target - pose.current) * k;
    }
    if (root.userData.slidePose) {
      const pose = root.userData.slidePose;
      pose.current += (pose.target - pose.current) * k;
    }
    const t =
      root.userData.crouchPose && root.userData.crouchPose.current
        ? root.userData.crouchPose.current
        : 0;
    const proneT =
      root.userData.pronePose && root.userData.pronePose.current
        ? root.userData.pronePose.current
        : 0;
    const slideT =
      root.userData.slidePose && root.userData.slidePose.current
        ? root.userData.slidePose.current
        : 0;

    const wrap = root.getObjectByName('SoldierFacing') || root;
    wrap.scale.set(
      1 + slideT * 0.15,
      Math.max(0.28, 1 - t * 0.34 - proneT * 0.42),
      1 + t * 0.04 + slideT * 0.15
    );

    const gun = wrap.getObjectByName('Weapon');
    if (gun) {
      const loco = root.userData.loco;
      let baseY;
      let baseRx;
      if (loco) {
        baseY = loco.gunY0 + (loco.bobY || 0);
        baseRx = loco.gunRx0 + (loco.bobRx || 0);
      } else {
        if (gun.userData._standPosY == null) {
          gun.userData._standPosY = gun.position.y;
          gun.userData._standRotX = gun.rotation.x;
        }
        baseY = gun.userData._standPosY;
        baseRx = gun.userData._standRotX;
      }
      gun.position.y = baseY - t * 0.28 - proneT * 0.22;
      gun.rotation.x = baseRx - t * 0.4 - proneT * 0.55;
    }

    // Knees / boots hint: pull team marker slightly if present
    const marker = root.getObjectByName('TeamMarker');
    if (marker) marker.position.y = 0.05 + t * 0.02;
  }

  /** Cache limb / gun rest pose for locomotion */
  function initLocomotion(root) {
    if (!root || root.userData.loco) return root.userData.loco;
    const wrap = root.getObjectByName('SoldierFacing') || root;
    const leftLeg = wrap.getObjectByName('LeftLeg');
    const rightLeg = wrap.getObjectByName('RightLeg');
    const gun = wrap.getObjectByName('Weapon');
    const loco = {
      leftLeg: leftLeg,
      rightLeg: rightLeg,
      gun: gun,
      phase: Math.random() * Math.PI * 2,
      swing: 0,
      bobY: 0,
      bobRx: 0,
      bobYaw: 0,
      legLx0: leftLeg ? leftLeg.rotation.x : 0,
      legRx0: rightLeg ? rightLeg.rotation.x : 0,
      gunY0: gun ? gun.position.y : 0,
      gunRx0: gun ? gun.rotation.x : 0,
      gunRy0: gun ? gun.rotation.y : 0,
      time: 0,
    };
    if (gun) {
      gun.userData._standPosY = gun.position.y;
      gun.userData._standRotX = gun.rotation.x;
    }
    root.userData.loco = loco;
    return loco;
  }

  /**
   * MC-style walk / stop / gun-hold idle.
   * @param {object} [state]
   * @param {boolean} [state.moving]
   * @param {number} [state.speedRatio] 0..1+ relative walk intensity
   * @param {boolean} [state.onGround]
   */
  function updateLocomotion(root, dt, state) {
    if (!root) return;
    const loco = root.userData.loco || initLocomotion(root);
    if (!loco || (!loco.leftLeg && !loco.rightLeg && !loco.gun)) return;

    state = state || {};
    dt = dt || 0.016;
    const onGround = state.onGround !== false;
    let speedRatio = state.speedRatio != null ? state.speedRatio : state.moving ? 1 : 0;
    if (speedRatio < 0) speedRatio = 0;
    if (speedRatio > 1.4) speedRatio = 1.4;
    const moving = !!state.moving && speedRatio > 0.08 && onGround;

    const crouchT =
      root.userData.crouchPose && root.userData.crouchPose.current
        ? root.userData.crouchPose.current
        : 0;
    const ampScale = 1 - crouchT * 0.55;

    loco.time += dt;

    const WALK_HZ = 7.5;
    const WALK_AMP = 0.55;
    const blend = Math.min(1, dt * 8);

    let targetSwing = 0;
    if (moving) {
      loco.phase += dt * WALK_HZ * (0.65 + speedRatio * 0.55);
      targetSwing = Math.sin(loco.phase) * WALK_AMP * speedRatio * ampScale;
    } else if (!onGround) {
      targetSwing = loco.swing * 0.85;
      loco.phase += dt * 2;
    } else {
      // settle toward rest
      targetSwing = 0;
    }
    loco.swing += (targetSwing - loco.swing) * (moving ? Math.min(1, dt * 14) : blend);

    if (loco.leftLeg) loco.leftLeg.rotation.x = loco.legLx0 + loco.swing;
    if (loco.rightLeg) loco.rightLeg.rotation.x = loco.legRx0 - loco.swing;

    // Gun hold: walk bob vs slow idle breathe (hands stay parented to gun)
    let wantBobY = 0;
    let wantBobRx = 0;
    let wantBobYaw = 0;
    if (moving) {
      wantBobY = Math.sin(loco.phase * 2) * 0.018 * speedRatio;
      wantBobRx = Math.sin(loco.phase) * 0.04 * speedRatio;
      wantBobYaw = Math.sin(loco.phase) * 0.02 * speedRatio;
    } else if (onGround) {
      const t = loco.time;
      wantBobY = Math.sin(t * 1.6) * 0.012;
      wantBobRx = Math.sin(t * 1.35) * 0.02;
      wantBobYaw = Math.sin(t * 0.9) * 0.015;
    }
    loco.bobY += (wantBobY - loco.bobY) * blend;
    loco.bobRx += (wantBobRx - loco.bobRx) * blend;
    loco.bobYaw += (wantBobYaw - loco.bobYaw) * blend;

    if (loco.gun) {
      loco.gun.position.y = loco.gunY0 + loco.bobY;
      loco.gun.rotation.x = loco.gunRx0 + loco.bobRx;
      loco.gun.rotation.y = loco.gunRy0 + loco.bobYaw;
    }
  }

  /** Strip team ring for clean select-screen previews */
  function createPreviewSoldier(classId, opts) {
    const root = createClassSoldier(classId, {
      team: resolveFactionTeam(opts && opts.team),
    });
    const marker = root.getObjectByName('TeamMarker');
    if (marker) root.remove(marker);
    initLocomotion(root);
    return root;
  }

  global.VF = global.VF || {};
  global.VF.Soldier = {
    createSoldier,
    createClassSoldier,
    createPreviewSoldier,
    createViewModel,
    createBuildViewModel,
    createKnifeViewModel,
    createThrowableViewModel,
    createGadgetViewModel,
    styleGadgetViewModel,
    setCrouchPose,
    updateCrouchPose,
    initLocomotion,
    updateLocomotion,
    refreshTeamMarker,
    normalizeClassId,
    CLASSES,
    PALETTE,
  };
})(window);
