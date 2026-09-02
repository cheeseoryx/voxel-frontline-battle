/**
 * weapon-viewmodels.js — First-person voxel guns matched to inspect-panel silhouettes.
 */
(function (global) {
  'use strict';

  function box(w, h, d, color, x, y, z) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: color })
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    if (mesh.material) mesh.material.fog = false;
    return mesh;
  }

  function addRail(gun, z0, count, y) {
    y = y != null ? y : 0.13;
    for (let i = 0; i < count; i++) {
      gun.add(box(0.09, 0.03, 0.028, i % 2 ? 0x1a1e24 : 0x2e343c, 0, y, z0 - i * 0.05));
    }
  }

  const DARK = 0x1a1e24;
  const MID = 0x2e343c;
  const LIGHT = 0x4a515a;
  const WOOD = 0x6a4a32;
  const OLIVE = 0x6b7d5d;
  const CHAR = 0x2a2e34;

  const PRESET = {
    ar: { family: 'ak', wood: true },
    sg: { family: 'shotgun' },
    rpg: { family: 'rpg' },
    acr: { family: 'rifle', stock: 'fold', barrel: 0.3 },
    ak74: { family: 'ak', wood: true, barrel: 0.34 },
    auga3: { family: 'aug', body: OLIVE },
    famas: { family: 'famas' },
    sg550: { family: 'rifle', stock: 'solid', barrel: 0.4, long: true },
    f2000: { family: 'f2000' },
    ak15: { family: 'ak', wood: false, railed: true, barrel: 0.32 },
    scarh: { family: 'scar', mag: 'box' },
    fal: { family: 'fal' },
    g3: { family: 'g3' },
    g36c: { family: 'g36' },
    m4a1: { family: 'rifle', stock: 'fold', barrel: 0.28 },
    asval: { family: 'val' },
    groza: { family: 'groza' },
    hk419: { family: 'rifle', stock: 'fold', barrel: 0.3 },
    ak5c: { family: 'rifle', stock: 'solid', barrel: 0.32 },
    honeybadger: { family: 'val', short: true },
    mp7: { family: 'mp7' },
    pp2000: { family: 'pp2000' },
    p90: { family: 'p90' },
    vector: { family: 'vector' },
    ump45: { family: 'smg', stock: 'solid', magH: 0.2 },
    mp5: { family: 'smg', stock: 'fold', magH: 0.2 },
    pp19: { family: 'smg', stock: 'wire', magH: 0.2, ak: true },
    scorpionevo: { family: 'smg', stock: 'fold', magH: 0.22, modern: true },
    l86a1: { family: 'l86' },
    mg36: { family: 'g36', magH: 0.22, lmg: true },
    rpk16: { family: 'ak', wood: false, railed: true, barrel: 0.4, magH: 0.26 },
    m249: { family: 'saw' },
    ultimax100: { family: 'ultimax' },
    mk20: { family: 'dmr', barrel: 0.46 },
    m110: { family: 'dmr', barrel: 0.44 },
    mk14ebr: { family: 'ebr' },
    sr: { family: 'svd' },
    svd: { family: 'svd' },
    ssg69: { family: 'sniper', wood: true, magH: 0.12 },
    sv98: { family: 'sniper', magH: 0.14 },
    l96: { family: 'sniper', magH: 0.14 },
    rem700: { family: 'sniper', wood: true, magH: 0.12, shortMag: true },
    m200: { family: 'intervention' },
    msr: { family: 'sniper', modern: true, magH: 0.13 },
    m9: { family: 'pistol' },
    mp443: { family: 'pistol', compact: true },
    usp: { family: 'pistol' },
    glock18: { family: 'pistol', auto: true },
    unica: { family: 'revolver' },
    deserteagle: { family: 'pistol', heavy: true },
    rsh12: { family: 'revolver', heavy: true },
  };

  function familyOf(def) {
    const id = def && def.id;
    if (id && PRESET[id]) return PRESET[id].family;
    const style = (def && def.modelStyle) || '';
    if (style.indexOf('pistol') === 0 || style === 'machine-pistol') return 'pistol';
    if (style.indexOf('revolver') === 0) return 'revolver';
    if (style === 'p90') return 'p90';
    if (style === 'vector') return 'vector';
    if (style.indexOf('bullpup') >= 0) return 'aug';
    if (style === 'ak') return 'ak';
    if (style.indexOf('sniper') === 0) return 'sniper';
    if (style.indexOf('lmg') === 0) return 'saw';
    if (style === 'shotgun') return 'shotgun';
    if (style === 'rpg') return 'rpg';
    if (style === 'suppressed') return 'val';
    if (style.indexOf('smg') === 0) return 'smg';
    if (style === 'svd' || style === 'dmr' || style === 'dmr-long') return 'dmr';
    return 'rifle';
  }

  function buildGun(def) {
    const gun = new THREE.Group();
    gun.name = 'ViewGun';
    gun.frustumCulled = false;
    const preset = (def && PRESET[def.id]) || {};
    const family = familyOf(def);
    const dark = DARK;
    const mid = MID;
    const light = LIGHT;
    const wood = WOOD;
    let muzZ = -0.72;

    function magCurve(x, y, z, h) {
      gun.add(box(0.1, h || 0.22, 0.12, dark, x, y, z));
      gun.add(box(0.09, 0.08, 0.11, mid, x, y - (h || 0.22) * 0.55, z + 0.02));
    }
    function magBox(x, y, z, h) {
      gun.add(box(0.1, h || 0.18, 0.12, dark, x, y, z));
    }
    function magDrum(x, y, z) {
      gun.add(box(0.22, 0.22, 0.14, dark, x, y, z));
      gun.add(box(0.16, 0.16, 0.1, mid, x, y, z));
    }
    function opticHolo(z) {
      gun.add(box(0.1, 0.04, 0.14, dark, 0, 0.17, z));
      gun.add(box(0.09, 0.09, 0.1, mid, 0, 0.24, z));
      gun.add(box(0.03, 0.03, 0.02, 0xff4422, 0, 0.25, z - 0.08));
    }
    function opticScope(z, long) {
      gun.add(box(0.08, 0.08, long ? 0.36 : 0.28, dark, 0, 0.22, z));
      gun.add(box(0.1, 0.1, 0.06, mid, 0, 0.22, z + (long ? 0.16 : 0.12)));
      gun.add(box(0.1, 0.1, 0.06, mid, 0, 0.22, z - (long ? 0.18 : 0.14)));
      gun.add(box(0.04, 0.04, 0.04, 0x111111, 0, 0.22, z - (long ? 0.24 : 0.2)));
    }
    function stockSolid(z, camo) {
      gun.add(box(0.12, 0.1, 0.28, camo || mid, 0.01, 0.02, z));
      gun.add(box(0.1, 0.16, 0.08, dark, 0.01, -0.06, z + 0.12));
    }
    function stockFold(z) {
      gun.add(box(0.04, 0.04, 0.26, light, 0.06, 0.04, z));
      gun.add(box(0.1, 0.14, 0.06, dark, 0.06, -0.02, z + 0.12));
    }
    function stockWire(z) {
      gun.add(box(0.03, 0.03, 0.28, light, 0.05, 0.08, z));
      gun.add(box(0.03, 0.03, 0.28, light, 0.05, -0.04, z));
      gun.add(box(0.1, 0.16, 0.04, dark, 0.05, 0.02, z + 0.14));
    }
    function grip() {
      gun.add(box(0.09, 0.2, 0.1, dark, 0.03, -0.16, 0.1));
    }
    function barrel(len, z) {
      gun.add(box(0.05, 0.05, len, dark, 0, 0.04, z));
      muzZ = z - len * 0.5 - 0.04;
      gun.add(box(0.07, 0.07, 0.05, mid, 0, 0.04, muzZ));
    }

    if (family === 'pistol') {
      const heavy = !!preset.heavy;
      const auto = !!preset.auto;
      gun.add(box(heavy ? 0.16 : 0.11, heavy ? 0.14 : 0.11, heavy ? 0.34 : 0.26, dark, 0, 0.04, -0.04));
      gun.add(box(heavy ? 0.1 : 0.08, 0.08, heavy ? 0.22 : 0.16, mid, 0, 0.06, heavy ? -0.24 : -0.18));
      gun.add(box(0.1, auto ? 0.24 : 0.2, 0.12, dark, 0.02, -0.12, 0.08));
      magBox(0.02, -0.22, 0.08, heavy ? 0.14 : 0.12);
      gun.add(box(0.02, 0.02, 0.02, 0xff4422, 0, 0.12, 0.06));
      muzZ = heavy ? -0.4 : -0.3;
    } else if (family === 'revolver') {
      const heavy = !!preset.heavy;
      gun.add(box(heavy ? 0.16 : 0.14, heavy ? 0.16 : 0.14, 0.22, dark, 0, 0.04, 0));
      gun.add(box(heavy ? 0.2 : 0.18, heavy ? 0.2 : 0.18, 0.12, mid, 0, 0.02, 0.02));
      gun.add(box(0.07, 0.07, heavy ? 0.32 : 0.26, dark, 0, 0.06, -0.24));
      gun.add(box(0.1, 0.2, 0.12, dark, 0.02, -0.12, 0.1));
      muzZ = heavy ? -0.44 : -0.38;
    } else if (family === 'p90') {
      gun.add(box(0.16, 0.14, 0.46, CHAR, 0, 0.04, -0.06));
      gun.add(box(0.18, 0.07, 0.34, mid, 0, 0.15, -0.04));
      gun.add(box(0.14, 0.18, 0.18, dark, 0, -0.06, 0.16));
      gun.add(box(0.08, 0.08, 0.08, light, 0.08, 0.02, 0.18));
      barrel(0.16, -0.36);
      opticHolo(0);
    } else if (family === 'vector') {
      gun.add(box(0.14, 0.2, 0.26, CHAR, 0, 0.0, 0.04));
      gun.add(box(0.12, 0.24, 0.16, mid, 0, -0.14, 0.06));
      magBox(0, -0.3, 0.02, 0.24);
      stockFold(0.3);
      barrel(0.2, -0.3);
      addRail(-0.06, 6);
      opticHolo(-0.02);
      grip();
    } else if (family === 'aug') {
      const body = preset.body || CHAR;
      gun.add(box(0.14, 0.16, 0.52, body, 0, 0.04, 0.06));
      gun.add(box(0.12, 0.1, 0.22, dark, 0, -0.08, 0.18));
      magBox(0.02, -0.16, 0.18, 0.18);
      gun.add(box(0.1, 0.04, 0.36, dark, 0, 0.14, -0.02));
      barrel(0.26, -0.34);
      addRail(-0.02, 6, 0.16);
      opticHolo(-0.04);
      grip();
    } else if (family === 'famas') {
      gun.add(box(0.14, 0.14, 0.48, CHAR, 0, 0.04, 0.08));
      gun.add(box(0.1, 0.16, 0.28, mid, 0, 0.18, 0.02));
      magCurve(0.02, -0.14, 0.2, 0.2);
      barrel(0.24, -0.32);
      opticHolo(0.02);
      grip();
    } else if (family === 'f2000') {
      gun.add(box(0.16, 0.16, 0.52, CHAR, 0, 0.05, 0.06));
      gun.add(box(0.12, 0.08, 0.2, light, 0, 0.14, 0.04));
      magCurve(0.02, -0.14, 0.18, 0.2);
      stockSolid(0.3, mid);
      barrel(0.22, -0.32);
      opticHolo(-0.02);
      grip();
    } else if (family === 'groza') {
      gun.add(box(0.15, 0.16, 0.48, CHAR, 0, 0.04, 0.08));
      gun.add(box(0.1, 0.12, 0.22, mid, 0, 0.16, 0.02));
      magCurve(0.02, -0.16, 0.16, 0.24);
      barrel(0.22, -0.3);
      gun.add(box(0.1, 0.1, 0.1, mid, 0, 0.04, muzZ - 0.02));
      opticHolo(0);
      grip();
    } else if (family === 'l86') {
      gun.add(box(0.14, 0.14, 0.54, CHAR, 0, 0.04, 0.04));
      magCurve(0.02, -0.16, 0.14, 0.2);
      stockSolid(0.3, mid);
      barrel(0.4, -0.4);
      addRail(-0.04, 8);
      opticHolo(-0.04);
      grip();
    } else if (family === 'ak') {
      const body = preset.wood ? 0x3a3a38 : CHAR;
      gun.add(box(0.13, 0.12, 0.42, body, 0, 0.03, -0.04));
      if (preset.wood) gun.add(box(0.12, 0.1, 0.22, wood, 0.01, 0.02, 0.28));
      else stockFold(0.28);
      magCurve(0, -0.16, -0.04, preset.magH || 0.22);
      barrel(preset.barrel || 0.34, -0.42);
      if (preset.railed) addRail(-0.02, 7);
      opticHolo(-0.02);
      grip();
    } else if (family === 'val') {
      gun.add(box(0.12, 0.12, 0.4, CHAR, 0, 0.03, -0.02));
      magCurve(0, -0.16, 0.0, 0.2);
      stockWire(0.28);
      const supLen = preset.short ? 0.28 : 0.4;
      gun.add(box(0.08, 0.08, supLen, mid, 0, 0.04, preset.short ? -0.4 : -0.5));
      muzZ = preset.short ? -0.56 : -0.72;
      addRail(-0.02, 5);
      opticHolo(-0.02);
      grip();
    } else if (family === 'svd') {
      gun.add(box(0.12, 0.12, 0.52, CHAR, 0, 0.03, -0.1));
      stockWire(0.32);
      magCurve(0, -0.16, -0.02, 0.2);
      barrel(0.46, -0.54);
      opticScope(-0.08, true);
      gun.add(box(0.06, 0.06, 0.08, 0xff4422, 0, 0.32, -0.08));
      grip();
    } else if (family === 'dmr') {
      gun.add(box(0.12, 0.12, 0.5, CHAR, 0, 0.03, -0.08));
      stockSolid(0.3, mid);
      magBox(0, -0.16, -0.02, 0.16);
      barrel(preset.barrel || 0.42, -0.52);
      opticScope(-0.08, false);
      grip();
    } else if (family === 'ebr') {
      gun.add(box(0.13, 0.12, 0.52, CHAR, 0, 0.03, -0.1));
      stockFold(0.3);
      magBox(0, -0.16, -0.02, 0.16);
      barrel(0.46, -0.54);
      addRail(-0.06, 8);
      opticScope(-0.08, false);
      grip();
    } else if (family === 'intervention') {
      gun.add(box(0.16, 0.14, 0.5, CHAR, 0, 0.04, -0.04));
      stockWire(0.34);
      magBox(0, -0.16, 0.04, 0.16);
      gun.add(box(0.1, 0.1, 0.62, mid, 0, 0.06, -0.58));
      muzZ = -0.92;
      opticScope(-0.08, true);
      grip();
    } else if (family === 'sniper') {
      const bodyCol = preset.wood ? wood : CHAR;
      gun.add(box(preset.modern ? 0.14 : 0.12, 0.12, 0.48, CHAR, 0, 0.04, -0.04));
      stockSolid(0.32, bodyCol);
      magBox(0, -0.14, 0.02, preset.magH || 0.14);
      barrel(0.54, -0.58);
      opticScope(-0.1, true);
      grip();
    } else if (family === 'saw') {
      gun.add(box(0.16, 0.16, 0.5, CHAR, 0, 0.04, -0.06));
      magBox(-0.12, 0.0, 0.06, 0.18);
      gun.add(box(0.22, 0.1, 0.18, mid, -0.08, 0.08, 0.04));
      stockSolid(0.3, mid);
      barrel(0.44, -0.5);
      addRail(-0.06, 8, 0.16);
      opticHolo(-0.04);
      grip();
    } else if (family === 'ultimax') {
      gun.add(box(0.15, 0.14, 0.48, CHAR, 0, 0.04, -0.06));
      magDrum(0, -0.16, 0.02);
      stockSolid(0.3, mid);
      barrel(0.4, -0.48);
      addRail(-0.04, 7);
      opticHolo(-0.04);
      grip();
    } else if (family === 'mp7') {
      gun.add(box(0.12, 0.14, 0.3, CHAR, 0, 0.02, 0.02));
      gun.add(box(0.08, 0.14, 0.1, mid, 0, -0.1, -0.12));
      magBox(0, -0.2, 0.08, 0.16);
      stockWire(0.26);
      barrel(0.16, -0.26);
      addRail(-0.02, 5);
      opticHolo(0);
      grip();
    } else if (family === 'pp2000') {
      gun.add(box(0.13, 0.14, 0.32, CHAR, 0, 0.02, 0.02));
      magBox(0, -0.18, 0.12, 0.2);
      stockFold(0.24);
      barrel(0.16, -0.26);
      opticHolo(0.02);
      grip();
    } else if (family === 'smg') {
      gun.add(box(0.12, 0.12, preset.ak ? 0.36 : 0.32, CHAR, 0, 0.03, 0));
      magBox(0, -0.18, 0.02, preset.magH || 0.2);
      if (preset.stock === 'wire') stockWire(0.26);
      else if (preset.stock === 'solid') stockSolid(0.26, mid);
      else stockFold(0.24);
      barrel(preset.modern ? 0.2 : 0.24, -0.3);
      addRail(-0.04, 5);
      opticHolo(-0.02);
      grip();
    } else if (family === 'scar') {
      gun.add(box(0.14, 0.14, 0.46, CHAR, 0, 0.03, -0.06));
      magBox(0, -0.16, -0.02, 0.16);
      stockSolid(0.3, mid);
      barrel(0.34, -0.44);
      addRail(-0.04, 8);
      opticHolo(-0.06);
      grip();
    } else if (family === 'fal' || family === 'g3') {
      gun.add(box(0.13, 0.13, 0.48, CHAR, 0, 0.03, -0.08));
      magBox(0, -0.16, -0.02, 0.16);
      stockSolid(0.3, wood);
      barrel(0.42, -0.5);
      addRail(-0.04, 7);
      opticHolo(-0.06);
      grip();
    } else if (family === 'g36') {
      gun.add(box(0.14, 0.14, 0.42, CHAR, 0, 0.04, -0.04));
      gun.add(box(0.1, 0.12, 0.22, mid, 0, 0.16, -0.02));
      magBox(0, -0.18, 0, preset.magH || 0.18);
      stockFold(0.28);
      barrel(preset.lmg ? 0.36 : 0.28, -0.4);
      opticHolo(-0.02);
      grip();
    } else if (family === 'shotgun') {
      gun.add(box(0.12, 0.12, 0.42, CHAR, 0, 0.03, -0.06));
      gun.add(box(0.1, 0.1, 0.28, wood, 0.01, 0.02, 0.28));
      gun.add(box(0.08, 0.08, 0.28, mid, 0, -0.04, -0.12));
      barrel(0.36, -0.44);
      grip();
    } else if (family === 'rpg') {
      gun.add(box(0.16, 0.16, 0.7, mid, 0, 0.06, -0.1));
      gun.add(box(0.2, 0.2, 0.22, dark, 0, 0.06, -0.52));
      gun.add(box(0.1, 0.18, 0.12, dark, 0.04, -0.12, 0.16));
      muzZ = -0.66;
    } else {
      gun.add(box(0.13, 0.13, 0.44, CHAR, 0, 0.03, -0.06));
      magCurve(0, -0.16, -0.04, 0.2);
      stockFold(0.28);
      barrel(preset.barrel || 0.32, -0.44);
      addRail(-0.04, 8);
      opticHolo(-0.04);
      grip();
    }

    const muzzle = new THREE.Object3D();
    muzzle.name = 'Muzzle';
    muzzle.position.set(0, 0.04, muzZ);
    gun.add(muzzle);
    const flash = new THREE.PointLight(0xffaa44, 0, 8);
    flash.name = 'MuzzleFlash';
    muzzle.add(flash);
    gun.position.set(0.05, -0.05, -0.1);
    gun.rotation.set(0.1, 0.16, 0.05);
    return { gun: gun, muzzle: muzzle, flash: flash };
  }

  global.VF = global.VF || {};
  global.VF.WeaponViewModels = { buildGun: buildGun };
})(window);
