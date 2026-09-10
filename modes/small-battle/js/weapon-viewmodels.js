/**
 * weapon-viewmodels.js — Per-gun first-person voxel models.
 *
 * Before this existed every gun shared one rifle mesh that _restyleGun() merely
 * rescaled. Each id now gets its own silhouette, built from boxes so it matches
 * the voxel look of the rest of the game.
 *
 * buildGun() returns the gun group only. soldier.js parents the hands onto it
 * and nudges the left hand per style, so nothing here should add hands.
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

  const DARK = 0x1a1e24;
  const MID = 0x2e343c;
  const LIGHT = 0x4a515a;
  const WOOD = 0x6a4a32;
  const CHAR = 0x2a2e34;
  const TAN = 0x9a8258;
  const PLUM = 0x5a3a30;

  /**
   * ACR and HK419 ship with identical model parameters in the battlefield
   * build, which reads as the same gun twice. They get their own families here:
   * the ACR is the slim tan rifle with a full-length top rail, the HK419 is the
   * black quad-rail carbine on a buffer tube.
   */
  const PRESET = {
    // --- existing three, previously all one mesh ---
    ar: { family: 'ak', wood: true, barrel: 0.32 },
    sg: { family: 'shotgun' },
    sr: { family: 'svd' },
    // --- ported ---
    ak74: { family: 'ak', wood: false, plum: true, barrel: 0.34, brake: true },
    acr: { family: 'acr' },
    scarh: { family: 'scar' },
    m4a1: { family: 'carbine' },
    hk419: { family: 'hk416' },
    mp7: { family: 'mp7' },
    p90: { family: 'p90' },
    mp5: { family: 'smg', stock: 'fold', magH: 0.2 },
    m249: { family: 'saw' },
    mk14ebr: { family: 'ebr' },
    m200: { family: 'intervention' },
    usp: { family: 'pistol' },
  };

  function familyOf(def) {
    const id = def && def.id;
    if (id && PRESET[id]) return PRESET[id].family;
    const style = (def && def.modelStyle) || '';
    const cat = (def && def.category) || '';
    if (style.indexOf('pistol') === 0 || cat === 'pistol') return 'pistol';
    if (style === 'p90') return 'p90';
    if (style === 'shotgun' || cat === 'shotgun') return 'shotgun';
    if (style === 'ak') return 'ak';
    if (style === 'scar') return 'scar';
    if (style === 'carbine') return 'carbine';
    if (style.indexOf('sniper') === 0 || cat === 'sniper') return 'intervention';
    if (style.indexOf('lmg') === 0 || cat === 'lmg') return 'saw';
    if (style === 'svd') return 'svd';
    if (style.indexOf('dmr') === 0 || cat === 'dmr') return 'ebr';
    if (style.indexOf('smg') === 0 || cat === 'smg') return 'smg';
    return 'carbine';
  }

  function buildGun(def) {
    const gun = new THREE.Group();
    gun.name = 'ViewGun';
    gun.frustumCulled = false;
    const preset = (def && PRESET[def.id]) || {};
    const family = familyOf(def);
    let muzZ = -0.72;

    function rail(z0, count, y) {
      y = y != null ? y : 0.13;
      for (let i = 0; i < count; i++) {
        gun.add(box(0.09, 0.03, 0.028, i % 2 ? DARK : MID, 0, y, z0 - i * 0.05));
      }
    }
    function magCurve(x, y, z, h) {
      gun.add(box(0.1, h || 0.22, 0.12, DARK, x, y, z));
      gun.add(box(0.09, 0.08, 0.11, MID, x, y - (h || 0.22) * 0.55, z + 0.02));
    }
    function magBox(x, y, z, h) {
      gun.add(box(0.1, h || 0.18, 0.12, DARK, x, y, z));
    }
    function opticHolo(z) {
      gun.add(box(0.1, 0.04, 0.14, DARK, 0, 0.17, z));
      gun.add(box(0.09, 0.09, 0.1, MID, 0, 0.24, z));
      gun.add(box(0.03, 0.03, 0.02, 0xff4422, 0, 0.25, z - 0.08));
    }
    function opticScope(z, long) {
      gun.add(box(0.08, 0.08, long ? 0.36 : 0.28, DARK, 0, 0.22, z));
      gun.add(box(0.1, 0.1, 0.06, MID, 0, 0.22, z + (long ? 0.16 : 0.12)));
      gun.add(box(0.1, 0.1, 0.06, MID, 0, 0.22, z - (long ? 0.18 : 0.14)));
      gun.add(box(0.04, 0.04, 0.04, 0x111111, 0, 0.22, z - (long ? 0.24 : 0.2)));
    }
    function stockSolid(z, color) {
      gun.add(box(0.12, 0.1, 0.28, color || MID, 0.01, 0.02, z));
      gun.add(box(0.1, 0.16, 0.08, DARK, 0.01, -0.06, z + 0.12));
    }
    function stockFold(z) {
      gun.add(box(0.04, 0.04, 0.26, LIGHT, 0.06, 0.04, z));
      gun.add(box(0.1, 0.14, 0.06, DARK, 0.06, -0.02, z + 0.12));
    }
    function stockWire(z) {
      gun.add(box(0.03, 0.03, 0.28, LIGHT, 0.05, 0.08, z));
      gun.add(box(0.03, 0.03, 0.28, LIGHT, 0.05, -0.04, z));
      gun.add(box(0.1, 0.16, 0.04, DARK, 0.05, 0.02, z + 0.14));
    }
    /** AR-15 style buffer tube + rubber pad; reads very differently to a folder. */
    function stockTube(z) {
      gun.add(box(0.07, 0.07, 0.3, MID, 0.01, 0.05, z));
      for (let i = 0; i < 4; i++) {
        gun.add(box(0.08, 0.02, 0.02, DARK, 0.01, 0.05, z - 0.1 + i * 0.07));
      }
      gun.add(box(0.11, 0.15, 0.05, DARK, 0.01, 0.0, z + 0.16));
    }
    function grip() {
      gun.add(box(0.09, 0.2, 0.1, DARK, 0.03, -0.16, 0.1));
    }
    function barrel(len, z) {
      gun.add(box(0.05, 0.05, len, DARK, 0, 0.04, z));
      muzZ = z - len * 0.5 - 0.04;
      gun.add(box(0.07, 0.07, 0.05, MID, 0, 0.04, muzZ));
    }

    if (family === 'pistol') {
      // Slide + frame only, no stock or optic — smallest silhouette in the game.
      // Broken into contrasting slabs so it still reads as a pistol instead of
      // one dark mass at this distance from the lens.
      gun.add(box(0.085, 0.075, 0.26, DARK, 0, 0.055, -0.05)); // slide
      gun.add(box(0.075, 0.02, 0.22, LIGHT, 0, 0.095, -0.06)); // slide top
      gun.add(box(0.03, 0.035, 0.03, MID, 0, 0.105, 0.05)); // rear sight
      gun.add(box(0.02, 0.03, 0.02, 0xd8d8d0, 0, 0.1, -0.16)); // front sight
      gun.add(box(0.08, 0.05, 0.14, CHAR, 0, 0.005, 0)); // dust cover
      gun.add(box(0.075, 0.17, 0.1, 0x3a332c, 0.005, -0.085, 0.06)); // grip panels
      gun.add(box(0.08, 0.02, 0.105, DARK, 0.005, -0.175, 0.06)); // floorplate
      gun.add(box(0.03, 0.055, 0.03, DARK, 0, -0.02, 0.015)); // trigger guard
      gun.add(box(0.045, 0.045, 0.1, MID, 0, 0.055, -0.19)); // barrel
      muzZ = -0.25;
    } else if (family === 'ak') {
      // Slanted mag, top-cover receiver, gas tube over the barrel.
      const furniture = preset.wood ? WOOD : preset.plum ? PLUM : CHAR;
      gun.add(box(0.13, 0.12, 0.42, CHAR, 0, 0.03, -0.04));
      gun.add(box(0.12, 0.04, 0.34, MID, 0, 0.11, -0.06)); // dust cover
      gun.add(box(0.1, 0.09, 0.24, furniture, 0.01, 0.02, 0.26)); // butt
      gun.add(box(0.09, 0.07, 0.2, furniture, 0, 0.02, -0.3)); // handguard
      magCurve(0, -0.16, -0.04, preset.magH || 0.22);
      barrel(preset.barrel || 0.34, -0.42);
      if (preset.brake) {
        // AK-74 muzzle brake: the easiest way to tell it apart from the AKM.
        gun.add(box(0.1, 0.1, 0.09, MID, 0, 0.04, muzZ - 0.03));
        gun.add(box(0.11, 0.03, 0.08, DARK, 0, 0.08, muzZ - 0.03));
        muzZ -= 0.07;
      }
      opticHolo(-0.02);
      grip();
    } else if (family === 'acr') {
      // Slim tan body, uninterrupted top rail from receiver to gas block.
      gun.add(box(0.12, 0.13, 0.46, TAN, 0, 0.03, -0.06));
      gun.add(box(0.11, 0.06, 0.26, MID, 0, -0.05, -0.34)); // slim handguard
      magBox(0, -0.16, -0.02, 0.18);
      stockFold(0.28);
      rail(0.06, 12, 0.12); // full-length rail is the ACR's tell
      barrel(0.3, -0.46);
      opticHolo(-0.04);
      grip();
    } else if (family === 'hk416') {
      // Black quad rail + buffer tube: bulkier and squarer than the ACR.
      gun.add(box(0.14, 0.14, 0.4, CHAR, 0, 0.03, -0.02));
      const hgZ = -0.34;
      gun.add(box(0.13, 0.13, 0.3, DARK, 0, 0.04, hgZ)); // quad rail block
      for (let i = 0; i < 5; i++) {
        gun.add(box(0.145, 0.025, 0.03, MID, 0, 0.04, hgZ + 0.12 - i * 0.055));
        gun.add(box(0.03, 0.025, 0.145, MID, 0.07, 0.04, hgZ)); // side rail slab
      }
      magBox(0, -0.16, 0, 0.2);
      stockTube(0.3);
      barrel(0.24, -0.52);
      rail(0.06, 7, 0.13);
      opticHolo(-0.02);
      grip();
    } else if (family === 'carbine') {
      // M4: round handguard, A-frame front sight, buffer tube.
      gun.add(box(0.12, 0.13, 0.38, CHAR, 0, 0.03, -0.02));
      gun.add(box(0.1, 0.1, 0.28, MID, 0, 0.03, -0.32)); // round handguard
      gun.add(box(0.05, 0.13, 0.05, DARK, 0, 0.12, -0.46)); // front sight tower
      gun.add(box(0.06, 0.05, 0.06, MID, 0, 0.09, -0.16)); // gas block
      magCurve(0, -0.16, -0.02, 0.2);
      stockTube(0.28);
      barrel(0.26, -0.56);
      rail(0.06, 6, 0.13);
      opticHolo(-0.02);
      grip();
    } else if (family === 'scar') {
      // Long monolithic upper with a side-folding stock; heaviest rifle here.
      gun.add(box(0.14, 0.14, 0.5, 0x4a4a3c, 0, 0.03, -0.08)); // FDE receiver
      gun.add(box(0.13, 0.05, 0.42, MID, 0, 0.11, -0.1));
      magBox(0, -0.16, -0.04, 0.18);
      stockSolid(0.3, 0x4a4a3c);
      barrel(0.34, -0.5);
      rail(0.06, 9);
      opticHolo(-0.06);
      grip();
    } else if (family === 'mp7') {
      // Tiny PDW: mag in the grip, stubby barrel, wire stock.
      gun.add(box(0.12, 0.14, 0.3, CHAR, 0, 0.02, 0.02));
      gun.add(box(0.09, 0.2, 0.11, DARK, 0.01, -0.14, 0.06)); // grip holds the mag
      magBox(0.01, -0.26, 0.06, 0.14);
      gun.add(box(0.07, 0.08, 0.12, MID, 0, -0.04, -0.16)); // fore grip
      stockWire(0.26);
      barrel(0.14, -0.26);
      rail(-0.02, 5);
      opticHolo(0);
    } else if (family === 'p90') {
      // Bullpup shell with the horizontal top-mounted magazine.
      gun.add(box(0.16, 0.16, 0.48, CHAR, 0, 0.02, -0.04));
      gun.add(box(0.14, 0.06, 0.34, MID, 0, 0.13, -0.02)); // lay-flat magazine
      gun.add(box(0.13, 0.16, 0.16, DARK, 0, -0.08, 0.16)); // shoulder pad
      gun.add(box(0.1, 0.12, 0.12, DARK, 0, -0.06, -0.16)); // thumb-hole grip
      barrel(0.14, -0.34);
      gun.add(box(0.07, 0.05, 0.11, DARK, 0, 0.185, -0.06));
      gun.add(box(0.025, 0.025, 0.02, 0xff4422, 0, 0.195, -0.11));
    } else if (family === 'smg') {
      // MP5: slim tube receiver with the distinctive drum sight and cocking rib.
      gun.add(box(0.12, 0.12, 0.36, CHAR, 0, 0.03, 0));
      gun.add(box(0.05, 0.05, 0.3, MID, -0.06, 0.09, -0.06)); // cocking tube
      gun.add(box(0.1, 0.09, 0.18, DARK, 0, 0.0, -0.26)); // handguard
      gun.add(box(0.07, 0.08, 0.06, DARK, 0, 0.13, 0.08)); // drum rear sight
      magBox(0, -0.18, 0.02, preset.magH || 0.2);
      if (preset.stock === 'wire') stockWire(0.26);
      else if (preset.stock === 'solid') stockSolid(0.26, MID);
      else stockFold(0.24);
      barrel(0.16, -0.42);
      opticHolo(-0.02);
      grip();
    } else if (family === 'saw') {
      // Belt box hanging under the receiver + carry handle + bipod stubs.
      gun.add(box(0.16, 0.16, 0.5, CHAR, 0, 0.04, -0.06));
      gun.add(box(0.2, 0.16, 0.2, DARK, -0.02, -0.16, 0.04)); // ammo box
      gun.add(box(0.18, 0.04, 0.12, MID, -0.02, -0.06, 0.04)); // belt feed
      gun.add(box(0.05, 0.09, 0.24, MID, 0, 0.17, 0.04)); // carry handle
      stockSolid(0.3, MID);
      barrel(0.42, -0.5);
      gun.add(box(0.03, 0.14, 0.03, DARK, 0.06, -0.06, -0.44)); // bipod legs
      gun.add(box(0.03, 0.14, 0.03, DARK, -0.06, -0.06, -0.44));
      rail(-0.06, 8, 0.16);
      opticHolo(-0.04);
      grip();
    } else if (family === 'ebr') {
      // Chassis rifle: boxy alloy stock, long barrel, glass on top.
      gun.add(box(0.13, 0.12, 0.52, CHAR, 0, 0.03, -0.1));
      gun.add(box(0.14, 0.16, 0.22, MID, 0.01, -0.02, 0.26)); // chassis cheek riser
      stockFold(0.3);
      magBox(0, -0.16, -0.02, 0.16);
      barrel(0.46, -0.54);
      rail(-0.06, 8);
      opticScope(-0.08, false);
      grip();
    } else if (family === 'intervention') {
      // Longest gun in the game: heavy bull barrel with a big brake.
      gun.add(box(0.16, 0.14, 0.5, CHAR, 0, 0.04, -0.04));
      stockWire(0.34);
      magBox(0, -0.16, 0.04, 0.16);
      gun.add(box(0.1, 0.1, 0.6, MID, 0, 0.06, -0.56)); // bull barrel
      gun.add(box(0.13, 0.13, 0.1, DARK, 0, 0.06, -0.9)); // muzzle brake
      gun.add(box(0.03, 0.16, 0.03, DARK, 0.07, -0.04, -0.74)); // bipod
      gun.add(box(0.03, 0.16, 0.03, DARK, -0.07, -0.04, -0.74));
      muzZ = -0.96;
      opticScope(-0.08, true);
      grip();
    } else if (family === 'svd') {
      gun.add(box(0.12, 0.12, 0.52, CHAR, 0, 0.03, -0.1));
      gun.add(box(0.11, 0.1, 0.24, WOOD, 0.01, 0.0, 0.3)); // wood thumbhole stock
      gun.add(box(0.1, 0.08, 0.2, WOOD, 0, 0.0, -0.3)); // wood handguard
      magCurve(0, -0.16, -0.02, 0.2);
      barrel(0.46, -0.54);
      opticScope(-0.08, true);
      grip();
    } else if (family === 'shotgun') {
      gun.add(box(0.12, 0.12, 0.42, CHAR, 0, 0.03, -0.06));
      gun.add(box(0.1, 0.1, 0.28, WOOD, 0.01, 0.02, 0.28)); // wood stock
      gun.add(box(0.09, 0.09, 0.24, WOOD, 0, -0.05, -0.24)); // pump
      gun.add(box(0.07, 0.07, 0.3, MID, 0, -0.03, -0.3)); // mag tube
      barrel(0.36, -0.44);
      grip();
    } else {
      gun.add(box(0.13, 0.13, 0.44, CHAR, 0, 0.03, -0.06));
      magCurve(0, -0.16, -0.04, 0.2);
      stockFold(0.28);
      barrel(0.32, -0.44);
      rail(-0.04, 8);
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
    if (family === 'pistol') {
      // A one-handed hold sits higher and nearer the centre than a rifle.
      gun.position.set(-0.02, 0.04, -0.2);
      gun.rotation.set(0.08, 0.1, 0.03);
    } else {
      gun.position.set(0.05, -0.05, -0.1);
      gun.rotation.set(0.1, 0.16, 0.05);
    }
    return { gun: gun, muzzle: muzzle, flash: flash };
  }

  global.VF = global.VF || {};
  global.VF.WeaponViewModels = { buildGun: buildGun, familyOf: familyOf };
})(window);
