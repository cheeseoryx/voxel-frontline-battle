/**
 * gadgets.js — Loadout gadgets (slots 3–4), throwables (slot 5 / G), melee (slot 6).
 * Battlefield 6-inspired: medkit, C4, ammo crate, RPG, binoculars, frag/flash/smoke.
 */
(function (global) {
  'use strict';

  const GRENADE_MAX = 2;
  const C4_MAX = 2;
  const THROW_SPEED = 19;
  const THROW_GRAVITY = 16;

  const LIFE = {
    beacon: 120,
    supply: 45,
    medkit: 42,
    ammo: 42,
    sensor: 35,
    charge: 90,
    smoke: 14,
  };

  const GADGET_CATALOG = [
    {
      id: 'medkit',
      name: '急救箱',
      kind: 'medkit',
      flavor: '战地救治',
      desc: '部署后持续恢复附近友军生命值。参考战地 6 补给袋的治疗部分：丢在队友身边即可回血。',
      tags: ['治疗', '部署', '友军'],
    },
    {
      id: 'charge',
      name: 'C4 炸药',
      kind: 'charge',
      flavor: '遥控爆破',
      desc: '投出后遥控引爆，可摧毁载具、工事与步兵。每条命携带 2 块；再次按下该栏位或左键引爆。',
      tags: ['爆破', '反载具', '工事'],
    },
    {
      id: 'ammo',
      name: '弹药箱',
      kind: 'ammo',
      flavor: '火力续航',
      desc: '部署后为附近友军补充枪弹、火箭弹与投掷物。参考战地 6 补给袋的补弹部分。',
      tags: ['补给', '弹药', '部署'],
    },
    {
      id: 'rpg',
      name: 'RPG-7 反载具火箭筒',
      kind: 'rpg',
      flavor: '破甲一击',
      desc: '非制导反载具火箭筒，对装甲伤害高、对步兵溅射有限。所有兵种均可装备。',
      tags: ['反装甲', '直射', '高爆'],
      weapon: true,
    },
    {
      id: 'binoculars',
      name: '望远镜',
      kind: 'binoculars',
      flavor: '观察与指示',
      desc: '高倍观察并标记视野中的敌军与载具。参考战地 6 激光指示镜：标记后便于队友发现目标。',
      tags: ['侦察', '标记', '观察'],
    },
  ];

  const GRENADE_CATALOG = [
    {
      id: 'frag',
      name: '破片手榴弹',
      kind: 'frag',
      flavor: '范围杀伤',
      desc: '延时爆炸并抛出破片。近距离可击杀步兵，对载具与大型建筑效果有限。按 G 投出，每条命 2 发。',
      tags: ['步兵', '清房', '延时'],
    },
    {
      id: 'flash',
      name: '闪光弹',
      kind: 'flash',
      flavor: '致盲突入',
      desc: '爆炸后致盲并干扰附近敌军，适合突入掩体与夺点前的开门。按 G 投出，每条命 2 发。',
      tags: ['致盲', '突入', '干扰'],
    },
    {
      id: 'smoke',
      name: '烟雾弹',
      kind: 'smoke',
      flavor: '遮断视线',
      desc: '制造烟幕，阻挡瞄准、标记与锁敌视线，掩护推进或救援。按 G 投出，每条命 2 发。',
      tags: ['掩护', '遮断', '救援'],
    },
  ];

  const MELEE_CATALOG = [
    {
      id: 'knife',
      name: '战斗刀',
      kind: 'knife',
      flavor: '迅捷近战',
      desc: '挥砍最快，持刀时移动更快。背后偷袭伤害更高，正面无法一击致命。',
      tags: ['近战', '机动', '背刺'],
    },
    {
      id: 'sledge',
      name: '大锤',
      kind: 'sledge',
      flavor: '破障近战',
      desc: '挥击较慢，但能破坏装备、轻型掩体，并对载具造成少量伤害。',
      tags: ['近战', '破障', '载具'],
    },
  ];

  function now() {
    return performance.now();
  }

  function catalogById(list, id) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function loadoutState() {
    const g = global.VF && global.VF.game;
    const store = g || global.VF;
    if (!store.loadout) store.loadout = {};
    const state = store.loadout;
    if (!state.primary || state.primary === 'rpg') {
      const pref = g && g.preferredWeaponId;
      state.primary = pref && pref !== 'rpg' ? pref : 'ar';
    }
    if (g && g.preferredWeaponId === 'rpg') g.preferredWeaponId = state.primary;
    if (!state.secondary) state.secondary = (g && g.preferredSecondaryId) || 'm9';
    if (!catalogById(GADGET_CATALOG, state.gadget1)) state.gadget1 = 'medkit';
    if (!catalogById(GADGET_CATALOG, state.gadget2)) {
      state.gadget2 = state.gadget1 === 'ammo' ? 'medkit' : 'ammo';
    }
    if (state.gadget1 === state.gadget2) {
      state.gadget2 = state.gadget1 === 'medkit' ? 'ammo' : 'medkit';
    }
    if (!catalogById(GRENADE_CATALOG, state.grenade)) state.grenade = 'frag';
    if (!catalogById(MELEE_CATALOG, state.melee)) state.melee = 'knife';
    return state;
  }

  function GadgetSystem() {
    this.items = [];
    this.smokes = [];
    this.throws = [];
    this.pings = [];
    this.cooldowns = Object.create(null);
    this._seq = 0;
    this._bound = false;
    this.hand = 'weapon';
    this.grenades = GRENADE_MAX;
    this.c4Ammo = C4_MAX;
    this.meleeCd = 0;
    this.flashBlind = 0;
    this._meleeView = null;
    this._bind();
  }

  GadgetSystem.prototype._bind = function () {
    if (this._bound) return;
    this._bound = true;
    const self = this;
    document.addEventListener('keydown', function (event) {
      if (event.repeat) return;
      const g = global.VF && global.VF.game;
      if (!g || !g.running || !g.player || g.player.dead || !g.player.locked) return;
      if (g.player.vehicleId) return;
      if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return;
      if (g.levelEditing) return;
      if (event.code === 'Digit3') {
        event.preventDefault();
        self.selectLoadoutSlot(g, 'gadget1');
      } else if (event.code === 'Digit4') {
        event.preventDefault();
        self.selectLoadoutSlot(g, 'gadget2');
      } else if (event.code === 'Digit5') {
        event.preventDefault();
        self.selectLoadoutSlot(g, 'grenade');
      } else if (event.code === 'Digit6') {
        event.preventDefault();
        self.selectLoadoutSlot(g, 'melee');
      } else if (event.code === 'KeyG') {
        event.preventDefault();
        self.throwGrenade(g);
      }
    });
    document.addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      const g = global.VF && global.VF.game;
      if (!g || !g.running || !g.player || !g.player.locked || g.player.dead) return;
      if (g.player.vehicleId) return;
      if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return;
      if (g.weapons && g.weapons.mode === 'melee') {
        event.preventDefault();
        self.swingMelee(g);
      } else if (g.weapons && g.weapons.mode === 'gadget') {
        event.preventDefault();
        self.useHeld(g);
      }
    });
  };

  GadgetSystem.prototype._emit = function (type, data) {
    const C = global.VF && global.VF.Conquest;
    if (C && C._emit) C._emit(type, data);
  };

  GadgetSystem.prototype._ground = function (world, x, z) {
    if (world && world.getWalkHeight) return world.getWalkHeight(x, z);
    if (world && world.getTerrainTop) return world.getTerrainTop(x, z);
    return 1;
  };

  GadgetSystem.prototype._placement = function (game, distance) {
    const player = game.player;
    const p = player.object.position;
    const d = distance || 3;
    const x = p.x - Math.sin(player.yaw) * d;
    const z = p.z - Math.cos(player.yaw) * d;
    return { x: x, y: this._ground(game.world, x, z), z: z };
  };

  GadgetSystem.prototype._eyeThrow = function (player, speed) {
    const origin = player.getEyePosition();
    const dir = player.getLookDirection();
    const spd = speed != null ? speed : THROW_SPEED;
    return {
      x: origin.x + dir.x * 0.45,
      y: origin.y + dir.y * 0.45,
      z: origin.z + dir.z * 0.45,
      vx: dir.x * spd,
      vy: dir.y * spd + 3.1,
      vz: dir.z * spd,
    };
  };

  GadgetSystem.prototype._mesh = function (kind, team) {
    const color = team === 'enemy' ? 0xb93838 : 0x3087c9;
    const root = new THREE.Group();
    let body;
    if (kind === 'beacon') {
      body = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.55, 0.45),
        new THREE.MeshLambertMaterial({ color: color, emissive: color, emissiveIntensity: 0.35 })
      );
      const antenna = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 1.3, 0.08),
        new THREE.MeshLambertMaterial({ color: 0x333940 })
      );
      antenna.position.y = 0.75;
      root.add(antenna);
    } else if (kind === 'supply' || kind === 'ammo') {
      body = new THREE.Mesh(
        new THREE.BoxGeometry(1.15, 0.62, 0.82),
        new THREE.MeshLambertMaterial({ color: kind === 'ammo' ? 0x6b5a32 : 0x51643a })
      );
    } else if (kind === 'medkit') {
      body = new THREE.Mesh(
        new THREE.BoxGeometry(0.85, 0.42, 0.62),
        new THREE.MeshLambertMaterial({ color: 0xe8e4dc })
      );
      const crossH = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.08, 0.12),
        new THREE.MeshLambertMaterial({ color: 0xc42828 })
      );
      const crossV = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.08, 0.42),
        new THREE.MeshLambertMaterial({ color: 0xc42828 })
      );
      crossH.position.y = 0.28;
      crossV.position.y = 0.28;
      root.add(crossH);
      root.add(crossV);
    } else if (kind === 'sensor') {
      body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.38, 0.35, 10),
        new THREE.MeshLambertMaterial({ color: 0x5a6672, emissive: color, emissiveIntensity: 0.25 })
      );
    } else {
      body = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.18, 0.4),
        new THREE.MeshLambertMaterial({ color: 0x3b3027 })
      );
    }
    body.position.y = kind === 'ammo' || kind === 'supply' ? 0.33 : 0.22;
    root.add(body);
    root.userData.gadgetKind = kind;
    return root;
  };

  GadgetSystem.prototype._ready = function (key) {
    return !this.cooldowns[key] || this.cooldowns[key] <= now();
  };

  GadgetSystem.prototype._setCooldown = function (key, seconds) {
    this.cooldowns[key] = now() + seconds * 1000;
  };

  GadgetSystem.prototype.resetLife = function (game) {
    this.grenades = GRENADE_MAX;
    this.c4Ammo = C4_MAX;
    this.flashBlind = 0;
    this.meleeCd = 0;
    if (game) {
      const owned = this._ownedCharges(game);
      for (let i = 0; i < owned.length; i++) this.destroy(owned[i], 'respawn');
    }
    if (game && game.weapons && game.weapons.state && game.weapons.state.rpg) {
      const def = global.VF.WEAPONS && global.VF.WEAPONS.rpg;
      game.weapons.state.rpg.mag = def ? def.magSize : 1;
      game.weapons.state.rpg.reserve = def ? def.reserve : 2;
    }
    this.syncHud(game);
  };

  GadgetSystem.prototype.onWeaponEquip = function () {
    this.hand = 'weapon';
    this._syncHeldVisual(global.VF && global.VF.game);
  };

  GadgetSystem.prototype.hasRpg = function () {
    const state = loadoutState();
    return state.gadget1 === 'rpg' || state.gadget2 === 'rpg';
  };

  GadgetSystem.prototype.rpgHotbarSlot = function () {
    return loadoutState().gadget2 === 'rpg' ? 4 : 3;
  };

  GadgetSystem.prototype.holdingKnife = function () {
    const state = loadoutState();
    return this.hand === 'melee' && state.melee !== 'sledge';
  };

  GadgetSystem.prototype.isBinoculars = function () {
    return this.hand === 'gadget1' || this.hand === 'gadget2'
      ? this._heldGadgetId() === 'binoculars'
      : false;
  };

  GadgetSystem.prototype.binocularAdsFov = function () {
    return this.isBinoculars() ? 16 : null;
  };

  GadgetSystem.prototype._heldGadgetId = function () {
    const state = loadoutState();
    if (this.hand === 'gadget1') return state.gadget1;
    if (this.hand === 'gadget2') return state.gadget2;
    return null;
  };

  GadgetSystem.prototype.selectLoadoutSlot = function (game, slot) {
    if (game.building && game.building.exitMode) game.building.exitMode();
    const state = loadoutState();
    const weapons = game.weapons;
    if (slot === 'gadget1' || slot === 'gadget2') {
      const id = state[slot];
      const def = catalogById(GADGET_CATALOG, id) || GADGET_CATALOG[0];
      if (def && def.id === 'charge' && this._ownedCharges(game).length) {
        if (this.hand === slot || this.c4Ammo <= 0) {
          this.detonateOwned(game);
          if (this.c4Ammo <= 0) return;
        }
      }
      if (def && def.id === 'rpg') {
        this.hand = slot;
        if (weapons && weapons.equip) weapons.equip('rpg');
        if (weapons) weapons.mode = 'weapon';
        this._syncHeldVisual(game);
        if (global.VF.UI) global.VF.UI.setHotbarSlot(slot === 'gadget1' ? 3 : 4);
        this.syncHud(game);
        return;
      }
      this.hand = slot;
      if (weapons) {
        weapons.mode = 'gadget';
        weapons.firing = false;
      }
      if (game.player && game.player.setHeldMode) game.player.setHeldMode('weapon');
      this._syncHeldVisual(game);
      if (global.VF.UI) global.VF.UI.setHotbarSlot(slot === 'gadget1' ? 3 : 4);
      this.syncHud(game);
      return;
    }
    if (slot === 'grenade') {
      this.hand = 'grenade';
      if (weapons) {
        weapons.mode = 'gadget';
        weapons.firing = false;
      }
      if (game.player && game.player.setHeldMode) game.player.setHeldMode('weapon');
      this._syncHeldVisual(game);
      if (global.VF.UI) global.VF.UI.setHotbarSlot(5);
      this.syncHud(game);
      return;
    }
    if (slot === 'melee') {
      this.hand = 'melee';
      if (weapons) {
        weapons.mode = 'melee';
        weapons.firing = false;
      }
      this._syncHeldVisual(game);
      if (global.VF.UI) global.VF.UI.setHotbarSlot(6);
      this.syncHud(game);
    }
  };

  GadgetSystem.prototype._syncHeldVisual = function (game) {
    const player = game && game.player;
    if (!player) return;
    if (this.hand === 'melee') {
      this._setMeleeView(true, loadoutState().melee);
      return;
    }
    this._setMeleeView(false);
    const rpg =
      (this.hand === 'gadget1' || this.hand === 'gadget2') && this._heldGadgetId() === 'rpg';
    const showGun = this.hand === 'weapon' || rpg;
    if (player._weaponViewModel) {
      player._weaponViewModel.visible = !!showGun && player._heldMode !== 'build';
    }
  };

  GadgetSystem.prototype.useHeld = function (game) {
    if (this.hand === 'grenade') {
      this.throwGrenade(game);
      return;
    }
    const id = this._heldGadgetId();
    if (id === 'medkit' || id === 'ammo') this.deploy(id, game);
    else if (id === 'charge') this._useC4(game);
    else if (id === 'binoculars') this.spot(game);
  };

  GadgetSystem.prototype._useC4 = function (game) {
    const owned = this._ownedCharges(game);
    if (this.c4Ammo <= 0) {
      if (owned.length) this.detonateOwned(game);
      else if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('没有 C4');
      return;
    }
    const key = 'c4-throw';
    if (!this._ready(key)) return;
    this._setCooldown(key, 0.45);
    this.c4Ammo -= 1;
    const start = this._eyeThrow(game.player, 16);
    const mesh = this._mesh('charge', game.player.team || 'ally');
    mesh.position.set(start.x, start.y, start.z);
    game.scene.add(mesh);
    this.throws.push({
      kind: 'charge',
      mesh: mesh,
      x: start.x,
      y: start.y,
      z: start.z,
      vx: start.vx,
      vy: start.vy,
      vz: start.vz,
      life: 8,
      team: game.player.team || game.world._playerTeam || 'ally',
      ownerId: game.player.entityId || 'player-local',
    });
    this.syncHud(game);
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast(this.c4Ammo > 0 ? 'C4 已投出 · 再按栏位引爆' : 'C4 已投出 · 左键引爆');
    }
  };

  GadgetSystem.prototype._ownedCharges = function (game) {
    const ownerId = (game.player && game.player.entityId) || 'player-local';
    return this.items.filter(function (item) {
      return item.kind === 'charge' && item.ownerId === ownerId && !item.destroyed;
    });
  };

  GadgetSystem.prototype.detonateOwned = function (game) {
    const owned = this._ownedCharges(game);
    for (let i = 0; i < owned.length; i++) this.detonate(owned[i], game);
    return owned.length > 0;
  };

  GadgetSystem.prototype._removeOwned = function (kind, ownerId, squadId) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      const same =
        kind === 'beacon'
          ? item.kind === kind && item.squadId && item.squadId === squadId
          : item.kind === kind && item.ownerId === ownerId;
      if (same) this.destroy(item, 'replaced');
    }
  };

  GadgetSystem.prototype.deploy = function (kind, game, opts) {
    opts = opts || {};
    const player = game.player;
    const team = player.team || game.world._playerTeam || 'ally';
    const ownerId = player.entityId || 'player-local';
    const squadId = player.squadId || null;
    const pos = opts.position || this._placement(game, kind === 'charge' ? 2.2 : 3.2);
    if (game.world && game.world.isInBuilding && game.world.isInBuilding(pos.x, pos.z, 0.8)) {
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('此处无法部署');
      return null;
    }
    if (kind === 'medkit' || kind === 'ammo' || kind === 'supply' || kind === 'beacon') {
      this._removeOwned(kind, ownerId, squadId);
    }
    const id =
      ((global.VF.Conquest && global.VF.Conquest.matchId) || 'local') +
      ':gadget:' +
      ++this._seq;
    const mesh = this._mesh(kind, team);
    mesh.position.set(pos.x, pos.y, pos.z);
    game.scene.add(mesh);
    const hp = kind === 'ammo' || kind === 'supply' || kind === 'medkit' ? 120 : kind === 'beacon' ? 80 : 60;
    const item = {
      id: id,
      kind: kind,
      team: team,
      ownerId: ownerId,
      squadId: squadId,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      mesh: mesh,
      hp: hp,
      maxHp: hp,
      life: LIFE[kind] || 45,
      tick: 0,
      destroyed: false,
      armed: kind !== 'charge',
    };
    this.items.push(item);
    if (kind === 'beacon') {
      game.world._deployBeacons = game.world._deployBeacons || [];
      game.world._deployBeacons.push(item);
    }
    this._emit('gadget-deployed', {
      id: id,
      kind: kind,
      team: team,
      ownerId: ownerId,
      squadId: squadId,
      x: pos.x,
      y: pos.y,
      z: pos.z,
    });
    if (global.VF.UI && global.VF.UI.toast) {
      const names = {
        beacon: '部署信标',
        supply: '综合补给箱',
        medkit: '急救箱',
        ammo: '弹药箱',
        sensor: '运动传感器',
        charge: 'C4 炸药',
      };
      global.VF.UI.toast((names[kind] || '装备') + '已部署');
    }
    return item;
  };

  GadgetSystem.prototype.throwGrenade = function (game) {
    if (game.building && game.building.active && game.building.exitMode) game.building.exitMode();
    if (this.grenades <= 0) {
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('没有投掷物');
      return false;
    }
    const key = 'grenade:' + ((game.player && game.player.entityId) || 'player-local');
    if (!this._ready(key)) return false;
    const state = loadoutState();
    const type = state.grenade || 'frag';
    this.grenades -= 1;
    this._setCooldown(key, 0.85);
    const start = this._eyeThrow(game.player, type === 'smoke' ? 17 : THROW_SPEED);
    const mesh = this._grenadeMesh(type);
    mesh.position.set(start.x, start.y, start.z);
    game.scene.add(mesh);
    this.throws.push({
      kind: type,
      mesh: mesh,
      x: start.x,
      y: start.y,
      z: start.z,
      vx: start.vx,
      vy: start.vy,
      vz: start.vz,
      fuse: type === 'frag' ? 1.55 : type === 'flash' ? 1.15 : 0.85,
      life: 6,
      team: game.player.team || game.world._playerTeam || 'ally',
      ownerId: game.player.entityId || 'player-local',
      bounce: 0,
    });
    this.syncHud(game);
    return true;
  };

  GadgetSystem.prototype._grenadeMesh = function (type) {
    const color = type === 'smoke' ? 0xc8cdd0 : type === 'flash' ? 0xd8c45a : 0x4a5a3a;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshLambertMaterial({ color: color })
    );
    return mesh;
  };

  GadgetSystem.prototype._explodeThrow = function (proj, game) {
    if (proj.kind === 'smoke') {
      this._spawnSmoke(game, proj.x, proj.y, proj.z, proj.team);
    } else if (proj.kind === 'flash') {
      this._explodeFlash(proj, game);
    } else if (proj.kind === 'frag') {
      this._explodeFrag(proj, game);
    } else if (proj.kind === 'charge') {
      this.deploy('charge', game, { position: { x: proj.x, y: proj.y, z: proj.z } });
    }
    if (proj.mesh && proj.mesh.parent) proj.mesh.parent.remove(proj.mesh);
  };

  GadgetSystem.prototype._spawnSmoke = function (game, x, y, z, team) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xb8bcc0,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    for (let i = 0; i < 9; i++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(2.4 + (i % 3) * 0.35, 8, 6), mat.clone());
      const angle = (i / 9) * Math.PI * 2;
      puff.position.set(Math.cos(angle) * 2.2, 1.4 + (i % 2) * 1.3, Math.sin(angle) * 2.2);
      group.add(puff);
    }
    const gy = this._ground(game.world, x, z);
    group.position.set(x, gy, z);
    game.scene.add(group);
    const smoke = {
      id: ((global.VF.Conquest && global.VF.Conquest.matchId) || 'local') + ':smoke:' + ++this._seq,
      team: team,
      x: x,
      y: gy + 2,
      z: z,
      radius: 6.5,
      life: LIFE.smoke,
      maxLife: LIFE.smoke,
      mesh: group,
    };
    this.smokes.push(smoke);
    game.world._smokeVolumes = this.smokes;
    this._emit('smoke-deployed', { id: smoke.id, team: smoke.team, x: smoke.x, y: smoke.y, z: smoke.z });
  };

  GadgetSystem.prototype._explodeFrag = function (proj, game) {
    const radius = 7.2;
    const origin = new THREE.Vector3(proj.x, proj.y, proj.z);
    this._blastInfantry(game, origin, radius, 108, proj.team, proj.ownerId, 0.35, 'frag');
    this._blastVehicles(game, origin, radius, 28, 'antiArmor');
    this._blastGadgets(game, origin, radius, 90, proj.team);
    if (game.world && game.world.deformTerrainCircle) {
      game.world.deformTerrainCircle(proj.x, proj.z, 2.4, 0.35, { source: 'gadget', maxDepth: 0.45 });
    }
    if (game.weapons && game.weapons._spawnImpact) {
      game.weapons._spawnImpact(origin, 0xff7733, 0.85);
    }
  };

  GadgetSystem.prototype._explodeFlash = function (proj, game) {
    const radius = 11;
    const player = game.player;
    const p = player && player.object && player.object.position;
    if (p && Math.hypot(p.x - proj.x, p.z - proj.z) <= radius) {
      const eye = player.getEyePosition();
      const toFlash = new THREE.Vector3(proj.x - eye.x, proj.y - eye.y, proj.z - eye.z).normalize();
      const look = player.getLookDirection();
      const facing = look.dot(toFlash);
      const selfThrown = proj.ownerId === (player.entityId || 'player-local');
      const strength = Math.max(0, facing) * (selfThrown ? 0.45 : 1);
      if (strength > 0.12 && !this.blocksLine(eye, { x: proj.x, y: proj.y, z: proj.z })) {
        this.flashBlind = Math.max(this.flashBlind, selfThrown ? 0.55 : 1);
      }
    }
    const ai = game.ai;
    const lists = ai ? [ai.blue || [], ai.red || []] : [];
    const myTeam = proj.team;
    for (let L = 0; L < lists.length; L++) {
      for (let i = 0; i < lists[L].length; i++) {
        const unit = lists[L][i];
        if (!unit || !unit.alive || !unit.mesh) continue;
        const team = unit.team || (lists[L] === ai.red ? 'enemy' : 'ally');
        if (team === myTeam) continue;
        const dist = Math.hypot(unit.mesh.position.x - proj.x, unit.mesh.position.z - proj.z);
        if (dist > radius) continue;
        unit.flashedUntil = now() + 2800;
        unit.spottedUntil = now() + 3500;
      }
    }
  };

  GadgetSystem.prototype._resolveOwner = function (game, ownerId, team, weaponId) {
    if (game && game.player && (ownerId === 'player-local' || ownerId === game.player.entityId)) {
      return {
        entityId: game.player.entityId || 'player-local',
        team: game.player.team || team,
        weaponId: weaponId,
      };
    }
    const ai = game && game.ai;
    const lists = ai ? [ai.blue || [], ai.red || []] : [];
    for (let L = 0; L < lists.length; L++) {
      for (let i = 0; i < lists[L].length; i++) {
        const unit = lists[L][i];
        if (unit && (unit.entityId === ownerId || unit.id === ownerId)) {
          return { entityId: unit.entityId, team: unit.team || team, weaponId: weaponId };
        }
      }
    }
    return { entityId: ownerId || null, team: team, weaponId: weaponId };
  };

  GadgetSystem.prototype._blastInfantry = function (game, origin, radius, damage, team, ownerId, selfScale, weaponId) {
    weaponId = weaponId || 'frag';
    const attacker = this._resolveOwner(game, ownerId, team, weaponId);
    const fromPlayer = attacker.entityId === ((game.player && game.player.entityId) || 'player-local');
    const ai = game.ai;
    const lists = ai ? [ai.blue || [], ai.red || []] : [];
    for (let L = 0; L < lists.length; L++) {
      for (let i = 0; i < lists[L].length; i++) {
        const unit = lists[L][i];
        if (!unit || !unit.alive || !unit.mesh) continue;
        const unitTeam = unit.team || (lists[L] === ai.red ? 'enemy' : 'ally');
        if (unitTeam === team) continue;
        const dist = Math.hypot(unit.mesh.position.x - origin.x, unit.mesh.position.z - origin.z);
        if (dist > radius) continue;
        const dmg = Math.max(12, damage * (1 - dist / (radius + 0.1)));
        if (ai._damageUnit) {
          ai._damageUnit(unit, dmg, null, fromPlayer, attacker, { weaponId: weaponId });
        }
      }
    }
    const player = game.player;
    if (player && player.alive && !player.dead && player.takeDamage) {
      const dist = Math.hypot(player.object.position.x - origin.x, player.object.position.z - origin.z);
      if (dist <= 2.4) {
        const dmg = Math.max(8, damage * (1 - dist / 3) * (selfScale != null ? selfScale : 0.3));
        player.takeDamage(dmg, origin, attacker);
      }
    }
  };

  GadgetSystem.prototype._blastVehicles = function (game, origin, radius, damage, damageType) {
    if (!game.vehicles || !game.vehicles.getAll || !game.vehicles.applyDamage) return;
    const list = game.vehicles.getAll();
    for (let i = 0; i < list.length; i++) {
      const vehicle = list[i];
      if (!vehicle || !vehicle.alive || !vehicle.position) continue;
      const dist = Math.hypot(vehicle.position.x - origin.x, vehicle.position.z - origin.z);
      if (dist > radius) continue;
      const dmg = Math.max(4, damage * (1 - dist / (radius + 0.1)));
      game.vehicles.applyDamage(vehicle, dmg, {
        damageType: damageType || 'antiArmor',
        source: game.player,
        sourceId: (game.player && game.player.entityId) || 'player-local',
        weaponId: 'frag',
      });
    }
  };

  GadgetSystem.prototype._blastGadgets = function (game, origin, radius, damage, sourceTeam) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (!item || item.destroyed || item.team === sourceTeam) continue;
      const dist = Math.hypot(item.x - origin.x, item.z - origin.z);
      if (dist <= radius) this.damage(item, damage, sourceTeam);
    }
  };

  GadgetSystem.prototype.spot = function (game) {
    const player = game.player;
    const origin = player.getEyePosition();
    const dir = player.getLookDirection();
    const maxDist = 160;
    let best = null;
    let bestDist = maxDist;
    const ai = game.ai;
    const list = ai ? (player.team === 'enemy' ? ai.blue : ai.red) : [];
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (!unit || !unit.alive || !unit.mesh) continue;
      const pos = unit.mesh.position;
      const dx = pos.x - origin.x;
      const dy = pos.y + 1.1 - origin.y;
      const dz = pos.z - origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1 || dist > maxDist) continue;
      const nd = dist || 1;
      const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / nd;
      if (dot < 0.92) continue;
      if (this.blocksLine(origin, { x: pos.x, y: pos.y + 1.1, z: pos.z })) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = unit;
      }
    }
    if (best) {
      best.spottedUntil = now() + 8000;
      best.spottedBy = player.entityId || 'player-local';
      this._addPing(game, best.mesh.position, 8);
      this._emit('soldier-spotted', {
        actorId: best.spottedBy,
        targetId: best.entityId,
        sourceId: 'binoculars',
      });
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('已标记敌军');
      return true;
    }
    if (game.vehicles && game.vehicles.raycast) {
      const hit = game.vehicles.raycast(origin, dir, maxDist);
      if (hit && hit.vehicle && hit.vehicle.team !== player.team) {
        hit.vehicle.spottedUntil = now() + 9000;
        this._addPing(game, hit.point || hit.vehicle.position, 9);
        if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('已标记载具');
        return true;
      }
    }
    if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('未发现目标');
    return false;
  };

  GadgetSystem.prototype._addPing = function (game, pos, life) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.55, 16),
      new THREE.MeshBasicMaterial({ color: 0xffcc44, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, (pos.y || 0) + 2.2, pos.z);
    game.scene.add(mesh);
    this.pings.push({ mesh: mesh, life: life || 6 });
  };

  GadgetSystem.prototype.swingMelee = function (game) {
    if (this.meleeCd > 0) return;
    const state = loadoutState();
    const sledge = state.melee === 'sledge';
    this.meleeCd = sledge ? 0.72 : 0.34;
    const player = game.player;
    const origin = player.getEyePosition();
    const dir = player.getLookDirection();
    const range = sledge ? 2.15 : 1.85;
    const end = origin.clone().addScaledVector(dir, range);
    if (this._meleeView) this._meleeView.userData.swing = 1;
    if (player.punchFeedback) {
      player.punchFeedback({ pitch: sledge ? 0.08 : 0.05, shake: sledge ? 0.12 : 0.07 });
    }
    const ai = game.ai;
    const list = ai ? (player.team === 'enemy' ? ai.blue : ai.red) : [];
    let hit = false;
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (!unit || !unit.alive || !unit.mesh) continue;
      const pos = unit.mesh.position;
      const dx = pos.x - origin.x;
      const dy = pos.y + 0.9 - origin.y;
      const dz = pos.z - origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > range + 0.35) continue;
      const nd = dist || 1;
      if ((dx * dir.x + dy * dir.y + dz * dir.z) / nd < 0.55) continue;
      let dmg = sledge ? 58 : 44;
      const forwardX = -Math.sin(unit.yaw || 0);
      const forwardZ = -Math.cos(unit.yaw || 0);
      const toMeX = origin.x - pos.x;
      const toMeZ = origin.z - pos.z;
      const back = forwardX * toMeX + forwardZ * toMeZ;
      if (!sledge && back < 0) dmg = Math.round(dmg * 1.85);
      if (ai._damageUnit) ai._damageUnit(unit, dmg, dir, true, player, { weaponId: sledge ? 'sledge' : 'knife' });
      hit = true;
      break;
    }
    if (!hit && sledge && game.vehicles && game.vehicles.raycast) {
      const vehHit = game.vehicles.raycast(origin, dir, range);
      if (vehHit && vehHit.vehicle) {
        game.vehicles.applyDamage(vehHit.vehicle, 14, {
          damageType: 'antiArmor',
          source: player,
          sourceId: player.entityId || 'player-local',
          weaponId: 'sledge',
        });
        hit = true;
      }
    }
    if (!hit) {
      const gadgetHit = this.raycast(origin, dir, range, player.team || 'ally');
      if (gadgetHit) {
        this.damage(gadgetHit.item, sledge ? 80 : 35, player.team || 'ally');
        hit = true;
      }
    }
    if (game.weapons && game.weapons._spawnImpact) {
      game.weapons._spawnImpact(end, hit ? 0xffaa66 : 0x8899aa, hit ? 0.22 : 0.08);
    }
  };

  GadgetSystem.prototype._setMeleeView = function (on, meleeId) {
    const player = global.VF.game && global.VF.game.player;
    if (!player || !player.camera) return;
    if (this._meleeView) {
      player.camera.remove(this._meleeView);
      this._meleeView.traverse(function (node) {
        if (node.geometry && node.geometry.dispose) node.geometry.dispose();
        if (node.material && node.material.dispose) node.material.dispose();
      });
      this._meleeView = null;
    }
    if (player._weaponViewModel) {
      player._weaponViewModel.visible = !on && player._heldMode !== 'build';
    }
    if (!on) return;
    const root = new THREE.Group();
    const sledge = meleeId === 'sledge';
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(sledge ? 0.18 : 0.05, sledge ? 0.18 : 0.04, sledge ? 0.55 : 0.42),
      new THREE.MeshLambertMaterial({ color: sledge ? 0x6a6e72 : 0xc5cdd4 })
    );
    blade.position.set(0.22, -0.18, -0.42);
    blade.rotation.z = 0.4;
    root.add(blade);
    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.16),
      new THREE.MeshLambertMaterial({ color: 0x3a2a1c })
    );
    grip.position.set(0.18, -0.22, -0.22);
    root.add(grip);
    player.camera.add(root);
    this._meleeView = root;
  };

  GadgetSystem.prototype.detonate = function (item, game) {
    if (!item || item.destroyed || item.kind !== 'charge') return false;
    const origin = new THREE.Vector3(item.x, item.y, item.z);
    this._blastInfantry(game, origin, 7.5, 130, item.team, item.ownerId, 0.2, 'c4');
    this._blastVehicles(game, origin, 9, 160, 'antiArmor');
    this._blastGadgets(game, origin, 6, 120, item.team);
    if (game.world && game.world.deformTerrainCircle) {
      game.world.deformTerrainCircle(item.x, item.z, 4.5, 0.7, { source: 'gadget', maxDepth: 0.9 });
    }
    if (game.weapons && game.weapons._spawnImpact) {
      game.weapons._spawnImpact(new THREE.Vector3(item.x, item.y + 0.5, item.z), 0xff7733, 1.1);
    }
    this._emit('gadget-detonated', { id: item.id, ownerId: item.ownerId, x: item.x, y: item.y, z: item.z });
    this.destroy(item, 'detonated');
    return true;
  };

  GadgetSystem.prototype.damage = function (id, amount, sourceTeam) {
    const item = typeof id === 'string' ? this.items.find(function (entry) { return entry.id === id; }) : id;
    if (!item || item.destroyed || sourceTeam === item.team) return false;
    item.hp -= Math.max(0, amount || 0);
    if (item.hp <= 0) this.destroy(item, 'destroyed');
    return true;
  };

  GadgetSystem.prototype.destroy = function (item, reason) {
    if (!item || item.destroyed) return;
    item.destroyed = true;
    if (item.mesh && item.mesh.parent) item.mesh.parent.remove(item.mesh);
    if (item.mesh) {
      item.mesh.traverse(function (node) {
        if (node.geometry && node.geometry.dispose) node.geometry.dispose();
        if (node.material && node.material.dispose) node.material.dispose();
      });
    }
    const g = global.VF && global.VF.game;
    if (g && g.world && g.world._deployBeacons) {
      g.world._deployBeacons = g.world._deployBeacons.filter(function (entry) {
        return entry !== item;
      });
    }
    this._emit('gadget-destroyed', { id: item.id, kind: item.kind, reason: reason || 'expired' });
  };

  GadgetSystem.prototype._tickMedkit = function (item, dt, game) {
    item.tick -= dt;
    if (item.tick > 0) return;
    item.tick = 1;
    const radius = 5.5;
    const player = game.player;
    if (
      player &&
      player.alive &&
      !player.dead &&
      (player.team || game.world._playerTeam) === item.team &&
      Math.hypot(player.object.position.x - item.x, player.object.position.z - item.z) <= radius
    ) {
      const before = player.health;
      player.health = Math.min(player.maxHealth || 100, player.health + 16);
      if (player.health > before) {
        this._emit('soldier-healed', {
          actorId: item.ownerId,
          targetId: player.entityId || 'player-local',
          amount: player.health - before,
        });
        if (global.VF.UI) global.VF.UI.updateVitals(player.health, player.armor);
      }
    }
    const ai = game.ai;
    const list = ai ? (item.team === 'enemy' ? ai.red : ai.blue) : [];
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (!unit || !unit.alive || !unit.mesh) continue;
      if (Math.hypot(unit.mesh.position.x - item.x, unit.mesh.position.z - item.z) > radius) continue;
      const before = unit.hp;
      unit.hp = Math.min(unit.maxHp, unit.hp + 14);
      if (unit.hp > before) {
        this._emit('soldier-healed', { actorId: item.ownerId, targetId: unit.entityId, amount: unit.hp - before });
      }
    }
  };

  GadgetSystem.prototype._tickAmmo = function (item, dt, game) {
    item.tick -= dt;
    if (item.tick > 0) return;
    item.tick = 1;
    const radius = 5.5;
    const player = game.player;
    if (
      player &&
      player.alive &&
      !player.dead &&
      (player.team || game.world._playerTeam) === item.team &&
      Math.hypot(player.object.position.x - item.x, player.object.position.z - item.z) <= radius
    ) {
      let ammo = 0;
      if (game.weapons && game.weapons.addReserve) {
        ammo = game.weapons.addReserve(game.weapons.current, 22);
        if (game.weapons.state && game.weapons.state.rpg) {
          game.weapons.addReserve('rpg', 1);
        }
      }
      if (this.grenades < GRENADE_MAX) {
        item._grenadeAcc = (item._grenadeAcc || 0) + 1;
        if (item._grenadeAcc >= 3) {
          this.grenades = Math.min(GRENADE_MAX, this.grenades + 1);
          item._grenadeAcc = 0;
          this.syncHud(game);
        }
      }
      if (this.c4Ammo < C4_MAX) {
        item._c4Acc = (item._c4Acc || 0) + 1;
        if (item._c4Acc >= 4) {
          this.c4Ammo = Math.min(C4_MAX, this.c4Ammo + 1);
          item._c4Acc = 0;
          this.syncHud(game);
        }
      }
      if (ammo > 0) {
        this._emit('soldier-resupplied', {
          actorId: item.ownerId,
          targetId: player.entityId || 'player-local',
          amount: ammo,
        });
      }
    }
  };

  GadgetSystem.prototype._tickSupply = function (item, dt, game) {
    this._tickMedkit(item, dt, game);
    this._tickAmmo(item, dt, game);
  };

  GadgetSystem.prototype._tickSensor = function (item, dt, game) {
    item.tick -= dt;
    if (item.tick > 0) return;
    item.tick = 1;
    const ai = game.ai;
    const list = ai ? (item.team === 'enemy' ? ai.blue : ai.red) : [];
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (!unit || !unit.alive || !unit.mesh) continue;
      if (Math.hypot(unit.mesh.position.x - item.x, unit.mesh.position.z - item.z) > 22) continue;
      unit.spottedUntil = now() + 2200;
      unit.spottedBy = item.ownerId;
      this._emit('soldier-spotted', { actorId: item.ownerId, targetId: unit.entityId, sourceId: item.id });
    }
  };

  GadgetSystem.prototype._updateThrows = function (dt, game) {
    for (let i = this.throws.length - 1; i >= 0; i--) {
      const proj = this.throws[i];
      proj.vy -= THROW_GRAVITY * dt;
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;
      proj.z += proj.vz * dt;
      const ground = this._ground(game.world, proj.x, proj.z) + 0.12;
      if (proj.y <= ground) {
        proj.y = ground;
        if (proj.kind === 'frag' && (proj.bounce || 0) < 1) {
          proj.bounce = 1;
          proj.vy = Math.abs(proj.vy) * 0.28;
          proj.vx *= 0.55;
          proj.vz *= 0.55;
        } else if (proj.kind === 'charge' || proj.kind === 'smoke' || proj.kind === 'flash') {
          proj.fuse = Math.min(proj.fuse != null ? proj.fuse : 0, 0.05);
          proj.vx = proj.vz = proj.vy = 0;
        } else {
          proj.fuse = 0;
        }
      }
      if (proj.fuse != null) proj.fuse -= dt;
      proj.life -= dt;
      if (proj.mesh) proj.mesh.position.set(proj.x, proj.y, proj.z);
      if ((proj.fuse != null && proj.fuse <= 0) || proj.life <= 0) {
        this._explodeThrow(proj, game);
        this.throws.splice(i, 1);
      }
    }
  };

  GadgetSystem.prototype.update = function (dt, game) {
    if (!game) return;
    if (this.meleeCd > 0) this.meleeCd = Math.max(0, this.meleeCd - dt);
    if (this.flashBlind > 0) {
      this.flashBlind = Math.max(0, this.flashBlind - dt * 0.38);
    }
    if (this._meleeView && this._meleeView.userData.swing) {
      this._meleeView.userData.swing = Math.max(0, this._meleeView.userData.swing - dt * 5);
      const t = this._meleeView.userData.swing;
      this._meleeView.rotation.x = -t * 0.9;
    }
    this._updateThrows(dt, game);
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const ping = this.pings[i];
      ping.life -= dt;
      if (ping.mesh) {
        ping.mesh.rotation.z += dt * 2;
        ping.mesh.scale.setScalar(1 + Math.sin(now() / 180) * 0.12);
      }
      if (ping.life <= 0) {
        if (ping.mesh && ping.mesh.parent) ping.mesh.parent.remove(ping.mesh);
        this.pings.splice(i, 1);
      }
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (!item || item.destroyed) {
        this.items.splice(i, 1);
        continue;
      }
      item.life -= dt;
      if (item.kind === 'supply') this._tickSupply(item, dt, game);
      else if (item.kind === 'medkit') this._tickMedkit(item, dt, game);
      else if (item.kind === 'ammo') this._tickAmmo(item, dt, game);
      else if (item.kind === 'sensor') this._tickSensor(item, dt, game);
      else if (item.kind === 'charge' && !item.armed) item.armed = true;
      if (item.life <= 0) {
        this.destroy(item, 'expired');
        this.items.splice(i, 1);
      }
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const smoke = this.smokes[i];
      smoke.life -= dt;
      const alpha = Math.min(1, Math.max(0, smoke.life / 2, (smoke.maxLife - smoke.life) / 1.2));
      if (smoke.mesh) {
        smoke.mesh.children.forEach(function (puff) {
          if (puff.material) puff.material.opacity = 0.28 * alpha;
          puff.scale.multiplyScalar(1 + dt * 0.025);
        });
      }
      if (smoke.life <= 0) {
        if (smoke.mesh && smoke.mesh.parent) smoke.mesh.parent.remove(smoke.mesh);
        if (smoke.mesh) {
          smoke.mesh.traverse(function (node) {
            if (node.geometry && node.geometry.dispose) node.geometry.dispose();
            if (node.material && node.material.dispose) node.material.dispose();
          });
        }
        this.smokes.splice(i, 1);
      }
    }
    if (game.world) game.world._smokeVolumes = this.smokes;
    this._syncFlashOverlay();
  };

  GadgetSystem.prototype._syncFlashOverlay = function () {
    const el = document.getElementById('flash-overlay');
    if (!el) return;
    if (this.flashBlind > 0.02) {
      el.classList.remove('hidden');
      el.style.opacity = String(Math.min(1, this.flashBlind));
    } else {
      el.style.opacity = '0';
      el.classList.add('hidden');
    }
  };

  GadgetSystem.prototype.syncHud = function (game) {
    const state = loadoutState();
    const slots = document.querySelectorAll('#hotbar .slot');
    const g1 = catalogById(GADGET_CATALOG, state.gadget1) || GADGET_CATALOG[0];
    const g2 = catalogById(GADGET_CATALOG, state.gadget2) || GADGET_CATALOG[1];
    const grenade = catalogById(GRENADE_CATALOG, state.grenade) || GRENADE_CATALOG[0];
    const melee = catalogById(MELEE_CATALOG, state.melee) || MELEE_CATALOG[0];
    const names = { 3: g1, 4: g2, 5: grenade, 6: melee };
    const iconClass = {
      medkit: 'gadget-medkit',
      charge: 'gadget-charge',
      ammo: 'gadget-ammo',
      rpg: 'weapon-rpg',
      binoculars: 'gadget-binoculars',
      frag: 'gadget-frag',
      flash: 'gadget-flash',
      smoke: 'gadget-smoke',
      knife: 'gadget-knife',
      sledge: 'gadget-sledge',
    };
    const shortGrenade = { frag: '破片', flash: '闪光', smoke: '烟雾' };
    slots.forEach(function (el) {
      const slot = Number(el.dataset.slot);
      const info = names[slot];
      if (!info) return;
      const nameEl = el.querySelector('.slot-name');
      if (nameEl) {
        nameEl.textContent = slot === 5 ? shortGrenade[info.id] || info.name : info.name;
      }
      const icon = el.querySelector('.slot-icon');
      if (icon) icon.className = 'slot-icon ' + (iconClass[info.kind] || iconClass[info.id] || 'gadget-ammo');
      el.title =
        info.name +
        ' (' +
        slot +
        ')' +
        (slot === 5 ? ' · 按 G 投掷 · 余 ' + this.grenades : '');
      el.classList.remove('locked', 'build');
      el.classList.toggle('gadget-slot', slot === 3 || slot === 4);
    }, this);
    const count = document.getElementById('throwable-count');
    if (count) count.textContent = 'G ' + this.grenades;
    const c4 = document.getElementById('gadget-ammo');
    if (c4) {
      const held = this._heldGadgetId();
      if (held === 'charge') {
        c4.textContent = 'C4 ' + this.c4Ammo;
        c4.classList.remove('hidden');
      } else {
        c4.classList.add('hidden');
      }
    }
  };

  GadgetSystem.prototype.blocksLine = function (a, b) {
    if (!a || !b || !this.smokes.length) return false;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const len2 = abx * abx + aby * aby + abz * abz || 1;
    for (let i = 0; i < this.smokes.length; i++) {
      const smoke = this.smokes[i];
      let t =
        ((smoke.x - a.x) * abx + (smoke.y - a.y) * aby + (smoke.z - a.z) * abz) / len2;
      t = Math.max(0, Math.min(1, t));
      const x = a.x + abx * t;
      const y = a.y + aby * t;
      const z = a.z + abz * t;
      const dx = x - smoke.x;
      const dy = y - smoke.y;
      const dz = z - smoke.z;
      if (dx * dx + dy * dy + dz * dz <= smoke.radius * smoke.radius) return true;
    }
    return false;
  };

  GadgetSystem.prototype.listDeployBeacons = function (team) {
    return this.items.filter(function (item) {
      return item.kind === 'beacon' && item.team === team && !item.destroyed;
    });
  };

  GadgetSystem.prototype.raycast = function (origin, dir, maxDist, sourceTeam) {
    let best = null;
    let bestDist = maxDist;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (!item || item.destroyed || item.team === sourceTeam) continue;
      const cx = item.x;
      const cy = item.y + 0.45;
      const cz = item.z;
      const ox = origin.x - cx;
      const oy = origin.y - cy;
      const oz = origin.z - cz;
      const b = ox * dir.x + oy * dir.y + oz * dir.z;
      const c = ox * ox + oy * oy + oz * oz - 0.8 * 0.8;
      const disc = b * b - c;
      if (disc < 0) continue;
      const dist = -b - Math.sqrt(disc);
      if (dist < 0 || dist >= bestDist) continue;
      bestDist = dist;
      best = {
        item: item,
        dist: dist,
        point: origin.clone().addScaledVector(dir, dist),
      };
    }
    return best;
  };

  GadgetSystem.prototype.clear = function () {
    for (let i = 0; i < this.items.length; i++) this.destroy(this.items[i], 'round-end');
    const g = global.VF && global.VF.game;
    for (let i = 0; i < this.smokes.length; i++) {
      const smoke = this.smokes[i];
      if (smoke.mesh && smoke.mesh.parent) smoke.mesh.parent.remove(smoke.mesh);
    }
    for (let i = 0; i < this.throws.length; i++) {
      const proj = this.throws[i];
      if (proj.mesh && proj.mesh.parent) proj.mesh.parent.remove(proj.mesh);
    }
    for (let i = 0; i < this.pings.length; i++) {
      if (this.pings[i].mesh && this.pings[i].mesh.parent) this.pings[i].mesh.parent.remove(this.pings[i].mesh);
    }
    this.items.length = 0;
    this.smokes.length = 0;
    this.throws.length = 0;
    this.pings.length = 0;
    this.cooldowns = Object.create(null);
    this.grenades = GRENADE_MAX;
    this.c4Ammo = C4_MAX;
    this.flashBlind = 0;
    if (g && g.world) {
      g.world._deployBeacons = [];
      g.world._smokeVolumes = [];
    }
  };

  const Gadgets = new GadgetSystem();
  Gadgets.GADGET_CATALOG = GADGET_CATALOG;
  Gadgets.GRENADE_CATALOG = GRENADE_CATALOG;
  Gadgets.MELEE_CATALOG = MELEE_CATALOG;
  Gadgets.GRENADE_MAX = GRENADE_MAX;
  Gadgets.ensureLoadout = loadoutState;

  global.VF = global.VF || {};
  global.VF.Gadgets = Gadgets;
})(typeof window !== 'undefined' ? window : this);
