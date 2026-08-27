/**
 * conquest.js — PVE 大征服（战地 6 规则蓝本，不含载具）
 * 多旗占领 + 增援票；核心不再决定 PVE 胜负。PVP 1v1 仍走拆核。
 */
(function (global) {
  'use strict';

  const TICKETS_START = 1000;
  const ROUND_SEC = 45 * 60;
  const FLAG_RADIUS = 30;
  const CAPTURE_SEC = 10;
  const EMPTY_DECAY = 0.35;
  const BLEED_INTERVAL = 3;
  const SWEEP_SEC = 60;
  const DEPLOY_COUNTDOWN = 5;
  const MAX_FLAGS = 5;
  const SCORE_CAPTURE = 100;
  const SCORE_KILL = 25;
  const LETTERS = 'ABCDE';
  const COL = {
    ally: 0x33aaff,
    enemy: 0xff3344,
    neutral: 0xc8c4b8,
    contest: 0xffe08a,
  };

  function blankStats() {
    return {
      ally: { kills: 0, deaths: 0, captures: 0, score: 0 },
      enemy: { kills: 0, deaths: 0, captures: 0, score: 0 },
      player: { kills: 0, deaths: 0, captures: 0, score: 0 },
    };
  }

  function feelCq() {
    return (global.VF.Feel && global.VF.Feel.conquest) || {};
  }

  function Conquest() {
    this.active = false;
    this.phase = 'idle';
    this.matchId = '';
    this.tickets = { ally: TICKETS_START, enemy: TICKETS_START };
    this.ticketsMax = TICKETS_START;
    this.roundSec = ROUND_SEC;
    this.sweepSec = SWEEP_SEC;
    this.elapsed = 0;
    this.stats = blankStats();
    this.flags = [];
    this._root = null;
    this._bleedAcc = 0;
    this._bleedInterval = BLEED_INTERVAL;
    this._hudAt = 0;
    this._hintOn = false;
    this._lastHudKey = '';
    this._sweepAlly = 0;
    this._sweepEnemy = 0;
    this.playerHint = null;
    this._ended = false;
    this._endReason = '';
    this._winner = null;
    this._eventSeq = 0;
    this._casualtySeq = 0;
    this._casualties = Object.create(null);
    this._casualtyOrder = [];
    this._listeners = Object.create(null);
  }

  Conquest.prototype.isPve = function (game) {
    const g = game || (global.VF && global.VF.game);
    return !!(g && (g.mode !== 'pvp' || (g.pvp && g.pvp.conquest)));
  };

  Conquest.prototype.on = function (type, handler) {
    if (!type || typeof handler !== 'function') return function () {};
    const list = this._listeners[type] || (this._listeners[type] = []);
    if (list.indexOf(handler) < 0) list.push(handler);
    const self = this;
    return function () {
      self.off(type, handler);
    };
  };

  Conquest.prototype.off = function (type, handler) {
    const list = this._listeners[type];
    if (!list) return;
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  };

  Conquest.prototype._emit = function (type, data) {
    const event = {
      id: this.matchId + ':' + ++this._eventSeq,
      type: type,
      matchId: this.matchId,
      elapsed: this.elapsed,
      data: data || {},
    };
    const direct = (this._listeners[type] || []).slice();
    const all = (this._listeners['*'] || []).slice();
    for (let i = 0; i < direct.length; i++) {
      try {
        direct[i](event);
      } catch (err) {
        console.error('[VF] Conquest event ' + type, err);
      }
    }
    for (let i = 0; i < all.length; i++) {
      try {
        all[i](event);
      } catch (err) {
        console.error('[VF] Conquest event *', err);
      }
    }
    return event;
  };

  Conquest.prototype.getStateSnapshot = function () {
    return {
      version: 1,
      matchId: this.matchId,
      phase: this.phase,
      active: this.active,
      ended: this._ended,
      endReason: this._endReason,
      winner: this._winner,
      tickets: { ally: this.tickets.ally, enemy: this.tickets.enemy },
      ticketsMax: this.ticketsMax,
      elapsed: this.elapsed,
      roundSec: this.roundSec,
      sweepSec: this.sweepSec,
      sweep: { ally: this._sweepAlly, enemy: this._sweepEnemy },
      flags: this.flags.map(function (flag) {
        return {
          letter: flag.letter,
          owner: flag.owner,
          phase: flag.phase,
          attackingTeam: flag.attackingTeam,
          progress: flag.progress,
          capture: flag.capture,
          contested: flag.contested,
          allyN: flag.allyN,
          enemyN: flag.enemyN,
          x: flag.x,
          y: flag.y,
          z: flag.z,
        };
      }),
    };
  };

  Conquest.prototype.stop = function (opts) {
    this.active = false;
    this.phase = 'idle';
    this._ended = false;
    this._endReason = '';
    this._winner = null;
    this._clearMeshes();
    this.flags = [];
    this._bleedAcc = 0;
    this._lastHudKey = '';
    this._sweepAlly = 0;
    this._sweepEnemy = 0;
    this.elapsed = 0;
    this.playerHint = null;
    this.stats = blankStats();
    this._casualties = Object.create(null);
    this._casualtyOrder.length = 0;
    const g = global.VF && global.VF.game;
    if (g && g.world) {
      g.world._conquestFlags = [];
      g.world._deployList = null;
    }
    if (this._hintOn && global.VF.UI && global.VF.UI.setInteractHint) {
      global.VF.UI.setInteractHint(false);
      this._hintOn = false;
    }
    if (global.VF.UI && global.VF.UI.setScoreboardOpen) {
      global.VF.UI.setScoreboardOpen(false);
    }
    if (global.VF.Revive && global.VF.Revive.reset) global.VF.Revive.reset();
    if (global.VF.Gadgets && global.VF.Gadgets.clear) global.VF.Gadgets.clear();
    if (global.VF.Comms && global.VF.Comms.clear) global.VF.Comms.clear();
    if (global.VF.MatchFlow && global.VF.MatchFlow.stop) global.VF.MatchFlow.stop();
    if (!(opts && opts.silent) && global.VF.UI && global.VF.UI.setHudMode) {
      global.VF.UI.setHudMode('core');
    }
  };

  Conquest.prototype.start = function (game) {
    const g = game || (global.VF && global.VF.game);
    this.stop({ silent: true });
    if (!g || !this.isPve(g) || !g.scene || !g.world) return false;

    let specs = this._resolveFlagSpecs(g);
    if (!specs.length) specs = this._fallbackFlags(g);

    const feel = feelCq();
    this.active = true;
    this.phase = 'running';
    this.matchId =
      'cq-' +
      Date.now().toString(36) +
      '-' +
      Math.floor(Math.random() * 0xffffff)
        .toString(36)
        .padStart(4, '0');
    this._ended = false;
    this._endReason = '';
    this._winner = null;
    this.ticketsMax = feel.tickets != null ? feel.tickets : TICKETS_START;
    this.roundSec = feel.roundSec != null ? feel.roundSec : ROUND_SEC;
    this.sweepSec = feel.sweepSec != null ? feel.sweepSec : SWEEP_SEC;
    this._bleedInterval = feel.bleedInterval != null ? feel.bleedInterval : BLEED_INTERVAL;
    this.tickets = { ally: this.ticketsMax, enemy: this.ticketsMax };
    this.elapsed = 0;
    this.stats = blankStats();
    this._bleedAcc = 0;
    this._lastHudKey = '';
    this._sweepAlly = 0;
    this._sweepEnemy = 0;
    this._eventSeq = 0;
    this._casualtySeq = 0;
    this._casualties = Object.create(null);
    this._casualtyOrder.length = 0;
    this._root = new THREE.Group();
    this._root.name = 'ConquestFlags';
    g.scene.add(this._root);

    this.flags = [];
    for (let i = 0; i < specs.length && i < MAX_FLAGS; i++) {
      const spec = specs[i];
      let x = spec.x;
      let z = spec.z;
      if (g.world._clearFlagPlaza) {
        const gy = g.world._clearFlagPlaza(x, z, FLAG_RADIUS);
        spec.y = (gy != null ? gy : this._groundY(g.world, x, z) - 1) + 1;
      }
      const flag = {
        letter: spec.letter || LETTERS.charAt(i),
        x: x,
        z: z,
        y: spec.y || this._groundY(g.world, x, z),
        radius: FLAG_RADIUS,
        owner: spec.owner === 'ally' || spec.owner === 'enemy' ? spec.owner : 'neutral',
        capture: spec.owner === 'ally' ? 1 : spec.owner === 'enemy' ? -1 : 0,
        phase: spec.owner === 'ally' || spec.owner === 'enemy' ? 'held' : 'neutral',
        attackingTeam: null,
        progress: spec.owner === 'ally' || spec.owner === 'enemy' ? 1 : 0,
        resumePhase: null,
        contested: false,
        allyN: 0,
        enemyN: 0,
        mesh: null,
      };
      flag.mesh = this._makeFlagMesh(flag);
      this._tintFlag(flag);
      this._root.add(flag.mesh);
      this.flags.push(flag);
    }
    if (g.world.flushRebuilds) g.world.flushRebuilds(64);

    if (global.VF.UI && global.VF.UI.setHudMode) {
      global.VF.UI.setHudMode('conquest');
    }
    if (global.VF.UI && global.VF.UI.setObjective) {
      global.VF.UI.setObjective('占领旗帜 · 耗尽敌方增援');
    }
    this._syncHud(true);
    this._publishFlags(g);
    this._emit('round-start', this.getStateSnapshot());
    return true;
  };

  Conquest.prototype._resolveFlagSpecs = function (g) {
    const w = g.world;
    const placed =
      (g._mapKitFlags && g._mapKitFlags.length && g._mapKitFlags) ||
      (w && w._kitFlags && w._kitFlags.length && w._kitFlags) ||
      [];
    const fromKit = [];
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      if (!p || (p.kind && p.kind !== 'flag')) continue;
      const x = p.x != null ? p.x : p.cx;
      const z = p.z != null ? p.z : p.cz;
      if (x == null || z == null) continue;
      fromKit.push({
        x: x,
        z: z,
        y: this._groundY(w, x, z),
        letter: p.letter || '',
        owner: p.owner || 'neutral',
      });
    }
    fromKit.sort(function (a, b) {
      return a.x - b.x || a.z - b.z;
    });
    for (let i = 0; i < fromKit.length; i++) {
      fromKit[i].letter = LETTERS.charAt(i);
    }
    if (fromKit.length) return fromKit;
    return this._fallbackFlags(g);
  };

  Conquest.prototype._fallbackFlags = function (g) {
    const w = g.world;
    const bases = g.bases;
    const size = (w && w.worldSize) || 640;
    const ax = (bases && bases.allyOrigin && bases.allyOrigin.x) || size * 0.13;
    const az = (bases && bases.allyOrigin && bases.allyOrigin.z) || size * 0.5;
    const ex = (bases && bases.enemyOrigin && bases.enemyOrigin.x) || size * 0.87;
    const ez = (bases && bases.enemyOrigin && bases.enemyOrigin.z) || size * 0.5;
    const tList = [0.22, 0.38, 0.5, 0.62, 0.78];
    const owners = ['ally', 'ally', 'neutral', 'enemy', 'enemy'];
    const out = [];
    const dx = ex - ax;
    const dz = ez - az;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len;
    const pz = dx / len;
    for (let i = 0; i < tList.length; i++) {
      const t = tList[i];
      let x = ax + dx * t;
      let z = az + dz * t;
      const land = this._nudgeToLand(w, x, z, px, pz);
      out.push({
        x: land.x,
        z: land.z,
        y: this._groundY(w, land.x, land.z),
        letter: LETTERS.charAt(i),
        owner: owners[i] || 'neutral',
      });
    }
    return out;
  };

  Conquest.prototype._groundY = function (w, x, z) {
    if (!w) return 5;
    if (w.getWalkHeight) {
      const walk = w.getWalkHeight(x, z);
      if (walk != null && isFinite(walk)) return walk;
    }
    if (w.getTerrainTop) return w.getTerrainTop(x, z);
    const gx = Math.floor(x);
    const gz = Math.floor(z);
    if (w._surface) return (w._surface(gx, gz) || 4) + 1;
    if (w.groundY && w.worldSize) {
      return (w.groundY[gz * w.worldSize + gx] || 4) + 1;
    }
    return 5;
  };

  Conquest.prototype._nudgeToLand = function (w, x, z, px, pz) {
    if (!w) return { x: x, z: z };
    const inWater = function (wx, wz) {
      if (!w._riverInfo) return false;
      const info = w._riverInfo(Math.floor(wx), Math.floor(wz));
      return !!(info && info.inWater);
    };
    if (!inWater(x, z)) return { x: x, z: z };
    for (let s = 4; s <= 36; s += 4) {
      const cands = [
        [x + px * s, z + pz * s],
        [x - px * s, z - pz * s],
        [x + s, z],
        [x - s, z],
        [x, z + s],
        [x, z - s],
      ];
      for (let i = 0; i < cands.length; i++) {
        const cx = cands[i][0];
        const cz = cands[i][1];
        if (cx < 8 || cz < 8 || cx >= w.worldSize - 8 || cz >= w.worldSize - 8) continue;
        if (!inWater(cx, cz)) return { x: cx, z: cz };
      }
    }
    return { x: x, z: z };
  };

  Conquest.prototype._makeFlagMesh = function (flag) {
    const root = new THREE.Group();
    root.name = 'Flag_' + flag.letter;
    root.position.set(flag.x, flag.y, flag.z);

    const pole = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, 9.4, 0.26),
      new THREE.MeshLambertMaterial({ color: 0x2c3036 })
    );
    pole.position.y = 4.7;
    root.add(pole);

    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.35, 0.1),
      new THREE.MeshLambertMaterial({
        color: COL.neutral,
        emissive: COL.neutral,
        emissiveIntensity: 0.55,
      })
    );
    banner.position.set(1.15, 8.2, 0);
    banner.name = 'FlagBanner';
    root.add(banner);

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 16, 8),
      new THREE.MeshBasicMaterial({
        color: COL.neutral,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    beam.position.y = 8;
    beam.renderOrder = 1;
    root.add(beam);

    const discMat = new THREE.MeshBasicMaterial({
      color: COL.neutral,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(flag.radius, 48), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.06;
    disc.renderOrder = 2;
    root.add(disc);

    const ringMat = new THREE.MeshBasicMaterial({
      color: COL.neutral,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(flag.radius - 0.7, flag.radius, 48),
      ringMat
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.08;
    ring.renderOrder = 3;
    root.add(ring);

    const capMat = new THREE.MeshBasicMaterial({
      color: COL.contest,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const cap = new THREE.Mesh(
      new THREE.RingGeometry(flag.radius - 1.5, flag.radius - 0.7, 48),
      capMat
    );
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = 0.1;
    cap.renderOrder = 4;
    root.add(cap);

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      })
    );
    spr.position.y = 11.2;
    spr.scale.set(5, 5, 1);
    spr.renderOrder = 21;
    root.add(spr);

    root.userData.banner = banner;
    root.userData.beam = beam;
    root.userData.discMat = discMat;
    root.userData.ringMat = ringMat;
    root.userData.capMat = capMat;
    root.userData.letterCtx = ctx;
    root.userData.letterTex = tex;
    root.userData.letterKey = '';
    this._paintLetter(root, flag.letter, 'neutral', false);
    return root;
  };

  Conquest.prototype._paintLetter = function (mesh, letter, owner, contested) {
    const key = letter + ':' + owner + ':' + (contested ? 1 : 0);
    if (mesh.userData.letterKey === key) return;
    mesh.userData.letterKey = key;
    const ctx = mesh.userData.letterCtx;
    ctx.clearRect(0, 0, 128, 128);
    const hex =
      owner === 'ally' ? '#4aa3ff' : owner === 'enemy' ? '#ff5a4a' : '#f2f0ea';
    ctx.fillStyle = 'rgba(6,8,12,0.82)';
    ctx.strokeStyle = contested ? '#ffe08a' : hex;
    ctx.lineWidth = contested ? 9 : 6;
    if (owner === 'enemy') {
      ctx.beginPath();
      ctx.moveTo(64, 10);
      ctx.lineTo(118, 64);
      ctx.lineTo(64, 118);
      ctx.lineTo(10, 64);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(64, 64, 52, 0, Math.PI * 2);
      if (owner === 'neutral') {
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(64, 64, 38, 0, Math.PI * 2);
        ctx.strokeStyle = hex;
        ctx.lineWidth = 4;
        ctx.stroke();
      } else {
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.fillStyle = hex;
    ctx.font = 'bold 58px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, 64, 66);
    mesh.userData.letterTex.needsUpdate = true;
  };

  Conquest.prototype._tintFlag = function (flag) {
    const mesh = flag.mesh;
    if (!mesh) return;
    const col = flag.contested
      ? COL.contest
      : flag.owner === 'ally'
        ? COL.ally
        : flag.owner === 'enemy'
          ? COL.enemy
          : COL.neutral;
    const banner = mesh.userData.banner;
    if (banner && banner.material) {
      banner.material.color.setHex(col);
      if (banner.material.emissive) banner.material.emissive.setHex(col);
    }
    const beam = mesh.userData.beam;
    if (beam && beam.material) {
      beam.material.color.setHex(col);
      beam.material.opacity = flag.contested ? 0.5 : 0.28;
    }
    if (mesh.userData.discMat) mesh.userData.discMat.color.setHex(col);
    if (mesh.userData.ringMat) mesh.userData.ringMat.color.setHex(col);
    if (mesh.userData.capMat) {
      mesh.userData.capMat.opacity = flag.contested ? 0.55 : Math.min(1, Math.abs(flag.capture)) * 0.45;
    }
    this._paintLetter(mesh, flag.letter, flag.owner, flag.contested);
  };

  Conquest.prototype._clearMeshes = function () {
    if (!this._root) return;
    const root = this._root;
    if (root.parent) root.parent.remove(root);
    root.traverse(function (c) {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (c.material.map && c.material.map.dispose) c.material.map.dispose();
        if (c.material.dispose) c.material.dispose();
      }
    });
    this._root = null;
  };

  Conquest.prototype._countIn = function (flag, game) {
    let ally = 0;
    let enemy = 0;
    const r2 = flag.radius * flag.radius;
    const player = game.player;
    if (player && !player.dead && player.object) {
      const p = player.object.position;
      const dx = p.x - flag.x;
      const dz = p.z - flag.z;
      if (dx * dx + dz * dz <= r2) {
        const team = player.team || (game.world && game.world._playerTeam) || 'ally';
        if (team === 'enemy') enemy++;
        else ally++;
      }
    }
    const pvp = global.VF && global.VF.Pvp;
    if (
      game.mode === 'pvp' &&
      game.pvp &&
      game.pvp.conquest &&
      pvp &&
      pvp.remoteState &&
      pvp.remoteState.alive !== false
    ) {
      const remote = pvp.remoteState;
      const dx = remote.x - flag.x;
      const dz = remote.z - flag.z;
      if (dx * dx + dz * dz <= r2) {
        if (remote.team === 'enemy') enemy++;
        else ally++;
      }
    }
    const ai = game.ai;
    const lists = [];
    if (ai) {
      if (ai.blue) lists.push(ai.blue);
      if (ai.red) lists.push(ai.red);
    }
    for (let L = 0; L < lists.length; L++) {
      const arr = lists[L];
      for (let i = 0; i < arr.length; i++) {
        const u = arr[i];
        if (!u || !u.alive || !u.mesh) continue;
        const q = u.mesh.position;
        const dx = q.x - flag.x;
        const dz = q.z - flag.z;
        if (dx * dx + dz * dz > r2) continue;
        if (u.team === 'enemy') enemy++;
        else ally++;
      }
    }
    return { ally: ally, enemy: enemy };
  };

  Conquest.prototype._captureRate = function (count) {
    const feel = feelCq();
    const maxPlayers = Math.max(1, feel.captureMaxPlayers != null ? feel.captureMaxPlayers : 4);
    const extra = feel.captureExtraSpeed != null ? feel.captureExtraSpeed : 0.28;
    return 1 + Math.max(0, Math.min(maxPlayers, count) - 1) * extra;
  };

  Conquest.prototype._syncFlagCapture = function (flag) {
    const phase = flag.phase === 'contested' ? flag.resumePhase || 'held' : flag.phase;
    if (flag.owner === 'ally') {
      flag.capture =
        phase === 'neutralizing' ? Math.max(0, 1 - flag.progress) : 1;
    } else if (flag.owner === 'enemy') {
      flag.capture =
        phase === 'neutralizing' ? -Math.max(0, 1 - flag.progress) : -1;
    } else if (phase === 'capturing') {
      flag.capture = (flag.attackingTeam === 'enemy' ? -1 : 1) * flag.progress;
    } else {
      flag.capture = 0;
    }
  };

  Conquest.prototype._tickFlagCapture = function (flag, counts, dt) {
    const feel = feelCq();
    const neutralizeSec = Math.max(
      1,
      feel.neutralizeSec != null ? feel.neutralizeSec : CAPTURE_SEC
    );
    const captureSec = Math.max(1, feel.captureSec != null ? feel.captureSec : CAPTURE_SEC);
    const emptyRecovery =
      feel.emptyRecoveryMul != null ? feel.emptyRecoveryMul : EMPTY_DECAY;
    const hadContest = flag.contested;
    const both = counts.ally > 0 && counts.enemy > 0;

    if (both) {
      if (!hadContest) {
        flag.resumePhase = flag.phase;
        this._emit('objective-contested', {
          letter: flag.letter,
          owner: flag.owner,
          phase: flag.resumePhase,
        });
      }
      flag.contested = true;
      flag.phase = 'contested';
      this._syncFlagCapture(flag);
      return;
    }

    flag.contested = false;
    if (hadContest) {
      flag.phase =
        flag.resumePhase ||
        (flag.owner === 'neutral'
          ? flag.progress > 0
            ? 'capturing'
            : 'neutral'
          : flag.progress > 0
            ? 'neutralizing'
            : 'held');
      flag.resumePhase = null;
      this._emit('objective-contest-ended', {
        letter: flag.letter,
        owner: flag.owner,
        phase: flag.phase,
      });
    }

    const activeTeam = counts.ally > 0 ? 'ally' : counts.enemy > 0 ? 'enemy' : null;
    const activeCount = activeTeam ? counts[activeTeam] : 0;

    if (!activeTeam) {
      if (flag.phase === 'neutralizing') {
        flag.progress = Math.max(0, flag.progress - (dt * emptyRecovery) / neutralizeSec);
        if (flag.progress <= 0) {
          flag.progress = 1;
          flag.phase = 'held';
          flag.attackingTeam = null;
        }
      } else if (flag.phase === 'capturing') {
        flag.progress = Math.max(0, flag.progress - (dt * emptyRecovery) / captureSec);
        if (flag.progress <= 0) {
          flag.phase = 'neutral';
          flag.attackingTeam = null;
        }
      }
      this._syncFlagCapture(flag);
      return;
    }

    const rate = this._captureRate(activeCount);
    if (flag.owner !== 'neutral') {
      if (activeTeam === flag.owner) {
        if (flag.phase === 'neutralizing') {
          flag.progress = Math.max(0, flag.progress - (dt * rate) / neutralizeSec);
          if (flag.progress <= 0) {
            flag.progress = 1;
            flag.phase = 'held';
            flag.attackingTeam = null;
          }
        }
      } else {
        if (flag.phase !== 'neutralizing') {
          flag.phase = 'neutralizing';
          flag.progress = 0;
        }
        flag.attackingTeam = activeTeam;
        flag.progress = Math.min(1, flag.progress + (dt * rate) / neutralizeSec);
        if (flag.progress >= 1) {
          const previousOwner = flag.owner;
          flag.owner = 'neutral';
          flag.phase = 'neutral';
          flag.progress = 0;
          flag.attackingTeam = null;
          this._emit('objective-neutralized', {
            letter: flag.letter,
            previousOwner: previousOwner,
            by: activeTeam,
          });
        }
      }
      this._syncFlagCapture(flag);
      return;
    }

    if (flag.phase !== 'capturing') {
      flag.phase = 'capturing';
      flag.attackingTeam = activeTeam;
      flag.progress = 0;
    }
    if (flag.attackingTeam === activeTeam) {
      flag.progress = Math.min(1, flag.progress + (dt * rate) / captureSec);
    } else {
      flag.progress = Math.max(0, flag.progress - (dt * rate) / captureSec);
      if (flag.progress <= 0) flag.attackingTeam = activeTeam;
    }
    if (flag.progress >= 1) {
      flag.owner = flag.attackingTeam || activeTeam;
      flag.phase = 'held';
      flag.progress = 1;
      flag.attackingTeam = null;
      this._emit('objective-captured', {
        letter: flag.letter,
        owner: flag.owner,
        occupants: activeCount,
      });
    }
    this._syncFlagCapture(flag);
  };

  Conquest.prototype.update = function (dt, game) {
    const g = game || (global.VF && global.VF.game);
    if (!this.active || !g || !this.isPve(g)) return;
    if (this._ended || (g.bases && (g.bases.won || g.bases.lost))) return;

    this.elapsed += dt;

    let hint = null;
    const player = g.player;
    const pTeam = (player && (player.team || (g.world && g.world._playerTeam))) || 'ally';

    for (let i = 0; i < this.flags.length; i++) {
      const f = this.flags[i];
      const n = this._countIn(f, g);
      f.allyN = n.ally;
      f.enemyN = n.enemy;

      const prevCap = f.capture;
      const prevOwner = f.owner;
      this._tickFlagCapture(f, n, dt);
      this._announceFlagChange(f, prevOwner, prevCap, g, player, pTeam);
      this._tintFlag(f);

      if (player && !player.dead && player.object) {
        const p = player.object.position;
        const dx = p.x - f.x;
        const dz = p.z - f.z;
        if (dx * dx + dz * dz <= f.radius * f.radius) hint = f;
      }
    }

    this._tickBleed(dt);
    this._tickSweep(dt);
    this._checkWin(g);
    this._syncHud(false);
    if (global.VF.UI && global.VF.UI.updateConquestLive) {
      global.VF.UI.updateConquestLive({
        hint: hint,
        flags: this.flags,
        tickets: this.tickets,
        max: this.ticketsMax,
        sweepAlly: this._sweepAlly,
        sweepEnemy: this._sweepEnemy,
        sweepNeed: this.sweepSec,
        timeLeft: this.timeLeft(),
        bleedAlly: this._heldCount('enemy'),
        bleedEnemy: this._heldCount('ally'),
        camera: g.camera,
        player: player,
        playerTeam: pTeam,
      });
    }

    let hintLabel = null;
    if (hint) {
      const foeN = pTeam === 'enemy' ? hint.allyN : hint.enemyN;
      hintLabel =
        hint.letter +
        ' · ' +
        (hint.contested
          ? '争夺中'
          : hint.owner === pTeam
            ? foeN > 0
              ? '丢失中'
              : '控制中'
            : hint.owner === 'neutral'
              ? '占领中'
              : '夺取中');
    }
    this.playerHint = hintLabel;

    this._publishFlags(g);
  };

  Conquest.prototype._publishFlags = function (g) {
    if (!g || !g.world) return;
    const self = this;
    g.world._conquestFlags = this.flags.map(function (f) {
      return {
        letter: f.letter,
        x: f.x,
        z: f.z,
        y: f.y,
        owner: f.owner,
        phase: f.phase,
        attackingTeam: f.attackingTeam,
        progress: f.progress,
        contested: f.contested,
        capture: f.capture,
        fullyHeld: self._isFullyHeld(f, f.owner),
      };
    });
  };

  Conquest.prototype._ownerFromCapture = function (c) {
    if (c >= 0.999) return 'ally';
    if (c <= -0.999) return 'enemy';
    if (c > 0.02) return 'ally';
    if (c < -0.02) return 'enemy';
    return 'neutral';
  };

  Conquest.prototype._isFullyHeld = function (flag, team) {
    if (!flag || flag.owner !== team) return false;
    if (flag.contested || (flag.phase && flag.phase !== 'held')) return false;
    if (typeof flag.capture !== 'number') return true;
    return Math.abs(flag.capture) >= 0.999;
  };

  Conquest.prototype._announceFlagChange = function (f, prevOwner, prevCap, g, player, pTeam) {
    const wasFull = Math.abs(prevCap) >= 0.999;
    const nowFull = Math.abs(f.capture) >= 0.999;
    if (!global.VF.UI || !global.VF.UI.toast) return;

    if (f.owner === 'neutral' && prevOwner !== 'neutral') {
      global.VF.UI.toast(f.letter + '点已中立');
      if (global.VF.Audio && global.VF.Audio.play) global.VF.Audio.play('confirm');
      return;
    }
    if (
      !nowFull ||
      f.phase !== 'held' ||
      (wasFull && prevOwner === f.owner) ||
      (f.owner !== 'ally' && f.owner !== 'enemy')
    ) {
      return;
    }

    let playerCapped = false;
    if (player && !player.dead && player.object && f.owner === pTeam) {
      const p = player.object.position;
      const dx = p.x - f.x;
      const dz = p.z - f.z;
      if (dx * dx + dz * dz <= f.radius * f.radius) playerCapped = true;
    }
    this.stats[f.owner].captures += 1;
    this.stats[f.owner].score += SCORE_CAPTURE;
    if (playerCapped) {
      this.stats.player.captures += 1;
      this.stats.player.score += SCORE_CAPTURE;
      this._emit('objective-player-capture', {
        actorId: player.entityId || 'player-local',
        team: pTeam,
        squadId: player.squadId || null,
        letter: f.letter,
      });
      global.VF.UI.toast('+' + SCORE_CAPTURE + ' 占领 ' + f.letter);
    } else {
      const who = f.owner === 'ally' ? '蓝方' : '红方';
      global.VF.UI.toast(who + '占领 ' + f.letter);
    }
    if (global.VF.Audio && global.VF.Audio.play) global.VF.Audio.play('confirm');
  };

  Conquest.prototype.timeLeft = function () {
    return Math.max(0, this.roundSec - this.elapsed);
  };

  Conquest.prototype._heldCount = function (team) {
    let n = 0;
    for (let i = 0; i < this.flags.length; i++) {
      if (this._isFullyHeld(this.flags[i], team)) n++;
    }
    return n;
  };

  Conquest.prototype._tickSweep = function (dt) {
    const total = this.flags.length;
    if (!total) {
      this._sweepAlly = 0;
      this._sweepEnemy = 0;
      return;
    }
    if (this._heldCount('ally') === total) {
      this._sweepAlly += dt;
      this._sweepEnemy = 0;
    } else if (this._heldCount('enemy') === total) {
      this._sweepEnemy += dt;
      this._sweepAlly = 0;
    } else {
      this._sweepAlly = 0;
      this._sweepEnemy = 0;
    }
  };

  Conquest.prototype._tickBleed = function (dt) {
    const allyF = this._heldCount('ally');
    const enemyF = this._heldCount('enemy');
    if (!allyF && !enemyF) {
      this._bleedAcc = 0;
      return;
    }
    this._bleedAcc += dt;
    const interval = this._bleedInterval || BLEED_INTERVAL;
    while (this._bleedAcc >= interval) {
      this._bleedAcc -= interval;
      if (allyF > 0) {
        this._addTickets('enemy', -allyF, 'flag-bleed', { heldBy: 'ally', flags: allyF });
      }
      if (enemyF > 0) {
        this._addTickets('ally', -enemyF, 'flag-bleed', { heldBy: 'enemy', flags: enemyF });
      }
    }
  };

  Conquest.prototype._addTickets = function (team, delta, reason, meta) {
    const t = team === 'enemy' ? 'enemy' : 'ally';
    const before = this.tickets[t];
    const after = Math.max(0, Math.min(this.ticketsMax, Math.floor(before + delta)));
    this.tickets[t] = after;
    const applied = after - before;
    if (applied !== 0) {
      this._emit('tickets-changed', {
        team: t,
        before: before,
        after: after,
        delta: applied,
        reason: reason || 'rule',
        meta: meta || null,
      });
    }
    return applied;
  };

  Conquest.prototype.registerCasualty = function (team, opts) {
    if (!this.active || this._ended) return null;
    const g = global.VF && global.VF.game;
    if (!g || !this.isPve(g)) return null;
    opts = opts || {};
    const t = team === 'enemy' ? 'enemy' : 'ally';
    const id =
      opts.lifeId ||
      opts.eventId ||
      this.matchId + ':casualty:' + t + ':' + ++this._casualtySeq;
    const known = this._casualties[id];
    if (known) return known;
    const casualty = {
      id: id,
      team: t,
      subjectId: opts.subjectId || null,
      player: !!opts.player,
      status: 'pending',
      downedAt: this.elapsed,
      finalizedAt: null,
      revivedAt: null,
      reason: opts.reason || 'combat',
    };
    this._casualties[id] = casualty;
    this._casualtyOrder.push(id);
    if (this._casualtyOrder.length > 512) {
      for (let i = 0; i < this._casualtyOrder.length; i++) {
        const oldId = this._casualtyOrder[i];
        const old = this._casualties[oldId];
        if (!old || old.status !== 'pending') {
          delete this._casualties[oldId];
          this._casualtyOrder.splice(i, 1);
          break;
        }
      }
    }
    this._emit('casualty-registered', casualty);
    return casualty;
  };

  Conquest.prototype.finalizeCasualty = function (casualtyOrId, opts) {
    opts = opts || {};
    const casualty =
      typeof casualtyOrId === 'string' ? this._casualties[casualtyOrId] : casualtyOrId;
    if (!casualty || casualty.status !== 'pending' || !this.active || this._ended) return false;
    casualty.status = 'finalized';
    casualty.finalizedAt = this.elapsed;
    casualty.reason = opts.reason || casualty.reason || 'combat';
    this.stats[casualty.team].deaths += 1;
    if (casualty.player) this.stats.player.deaths += 1;
    this._addTickets(casualty.team, -1, 'casualty', {
      casualtyId: casualty.id,
      subjectId: casualty.subjectId,
      reason: casualty.reason,
    });
    this._emit('casualty-finalized', casualty);
    this._syncHud(true);
    const g = global.VF && global.VF.game;
    if (g) this._checkWin(g);
    return true;
  };

  Conquest.prototype.reviveCasualty = function (casualtyOrId, opts) {
    opts = opts || {};
    const casualty =
      typeof casualtyOrId === 'string' ? this._casualties[casualtyOrId] : casualtyOrId;
    if (!casualty || casualty.status !== 'pending' || !this.active || this._ended) return false;
    casualty.status = 'revived';
    casualty.revivedAt = this.elapsed;
    casualty.reviverId = opts.reviverId || null;
    this._emit('casualty-revived', casualty);
    return true;
  };

  Conquest.prototype.onDeath = function (team, opts) {
    opts = opts || {};
    const casualty = this.registerCasualty(team, opts);
    if (!casualty) return null;
    if (!opts.defer) this.finalizeCasualty(casualty, opts);
    return casualty.id;
  };

  Conquest.prototype.onPlayerDown = function (team, opts) {
    opts = opts || {};
    opts.player = true;
    return this.onDeath(team, opts);
  };

  Conquest.prototype.onRespawn = function (team, opts) {
    if (!this.active) return;
    if (opts && opts.initial) return;
    const g = global.VF && global.VF.game;
    if (!g || !this.isPve(g) || this._ended) return;
    if (g.bases && (g.bases.won || g.bases.lost)) return;
    this._emit('soldier-respawned', {
      team: team === 'enemy' ? 'enemy' : 'ally',
      subjectId: opts && opts.subjectId ? opts.subjectId : null,
      casualtyId: opts && opts.casualtyId ? opts.casualtyId : null,
    });
  };

  Conquest.prototype.onKill = function (killerTeam, fromPlayer) {
    if (!this.active || this._ended) return;
    const t = killerTeam === 'enemy' ? 'enemy' : 'ally';
    this.stats[t].kills += 1;
    this.stats[t].score += SCORE_KILL;
    if (fromPlayer) {
      this.stats.player.kills += 1;
      this.stats.player.score += SCORE_KILL;
    }
  };

  Conquest.prototype._checkWin = function (g) {
    if (!this.active || !g || !g.bases || this._ended) return;
    if (g.bases.won || g.bases.lost) return;

    let winner = null;
    let reason = '';
    if (this.flags.length && this._sweepAlly >= this.sweepSec) {
      winner = 'ally';
      reason = 'sweep';
    } else if (this.flags.length && this._sweepEnemy >= this.sweepSec) {
      winner = 'enemy';
      reason = 'sweep';
    } else if (this.elapsed >= this.roundSec) {
      const a = this.tickets.ally;
      const e = this.tickets.enemy;
      if (a > e) winner = 'ally';
      else if (e > a) winner = 'enemy';
      else winner = this._heldCount('ally') >= this._heldCount('enemy') ? 'ally' : 'enemy';
      reason = 'timeout';
    } else {
      const a = this.tickets.ally;
      const e = this.tickets.enemy;
      if (a > 0 && e > 0) return;
      if (a <= 0 && e <= 0) {
        winner = this._heldCount('ally') >= this._heldCount('enemy') ? 'ally' : 'enemy';
      } else if (e <= 0) winner = 'ally';
      else winner = 'enemy';
      reason = 'tickets';
    }

    this._ended = true;
    this.phase = 'ended';
    this._endReason = reason;
    this._winner = winner;
    const playerTeam = (g.world && g.world._playerTeam) || (g.player && g.player.team) || 'ally';
    const playerWon = winner === playerTeam;
    g.bases.won = playerWon;
    g.bases.lost = !playerWon;

    let title;
    let sub;
    if (reason === 'sweep') {
      title = playerWon ? '关键任务成功' : '关键任务失败';
      sub = playerWon ? '全面占领并保持 60 秒' : '全部占领点失守';
    } else if (reason === 'timeout') {
      title = playerWon ? '占领胜利' : '占领失败';
      sub = playerWon ? '时间结束 · 增援领先' : '时间结束 · 增援落后';
    } else {
      title = playerWon ? '占领胜利' : '占领失败';
      sub = playerWon ? '敌方增援耗尽' : '我方增援耗尽';
    }
    if (global.VF.Economy && global.VF.Economy.grantMatchReward) {
      const reward = global.VF.Economy.grantMatchReward('pve', playerWon);
      const line =
        global.VF.Economy.formatRewardLine && global.VF.Economy.formatRewardLine(reward);
      if (line) sub = sub + ' · ' + line;
    }
    if (global.VF.UI && global.VF.UI.showVictory) {
      global.VF.UI.showVictory(title, sub);
    }
    if (global.VF.UI && global.VF.UI.closeSpawnSelect) global.VF.UI.closeSpawnSelect();
    if (global.VF.UI && global.VF.UI.hideDeath) global.VF.UI.hideDeath();
    if (global.VF.UI && global.VF.UI.setScoreboardOpen) global.VF.UI.setScoreboardOpen(false);
    this._syncHud(true);
    this._emit('round-ended', {
      winner: winner,
      reason: reason,
      tickets: { ally: this.tickets.ally, enemy: this.tickets.enemy },
    });
  };

  Conquest.prototype._enemyNear = function (team, x, z, radius) {
    const g = global.VF && global.VF.game;
    if (!g) return false;
    const enemyTeam = team === 'enemy' ? 'ally' : 'enemy';
    const r2 = radius * radius;
    const player = g.player;
    if (
      player &&
      player.alive &&
      !player.dead &&
      (player.team || (g.world && g.world._playerTeam) || 'ally') === enemyTeam
    ) {
      const pp = player.object && player.object.position;
      if (pp) {
        const dx = pp.x - x;
        const dz = pp.z - z;
        if (dx * dx + dz * dz <= r2) return true;
      }
    }
    const list = g.ai ? (enemyTeam === 'enemy' ? g.ai.red : g.ai.blue) : [];
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (!unit || !unit.alive || unit.downed || !unit.mesh) continue;
      const dx = unit.mesh.position.x - x;
      const dz = unit.mesh.position.z - z;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  };

  Conquest.prototype._deploySafety = function (team, entity, x, z) {
    const feel = feelCq();
    const combatLockSec = feel.deployCombatLockSec != null ? feel.deployCombatLockSec : 8;
    const enemyRadius = feel.deployEnemyRadius != null ? feel.deployEnemyRadius : 20;
    if (!entity || !entity.alive || entity.dead || entity.downed) {
      return { available: false, reason: '队友已倒地或阵亡' };
    }
    if (
      entity._lastCombatAt &&
      performance.now() - entity._lastCombatAt < combatLockSec * 1000
    ) {
      return { available: false, reason: '队友正在交战' };
    }
    if (this._enemyNear(team, x, z, enemyRadius)) {
      return { available: false, reason: '附近有敌军' };
    }
    return { available: true, reason: '' };
  };

  /** HQ + owned flags + safe squadmates + beacons the given team may deploy on. */
  Conquest.prototype.listDeployPoints = function (team) {
    const out = [];
    const g = global.VF && global.VF.game;
    const w = g && g.world;
    const t = team === 'enemy' ? 'enemy' : 'ally';
    const spots = w && w._spawnPoints && w._spawnPoints[t];
    let hq = null;
    if (spots) {
      for (let i = 0; i < spots.length; i++) {
        if (spots[i].fixed) {
          hq = spots[i];
          break;
        }
      }
      if (!hq) hq = spots[0];
    }
    if (hq) {
      out.push({
        id: hq.id,
        team: t,
        x: hq.x,
        y: hq.y,
        z: hq.z,
        label: '主基地',
        kind: 'hq',
        fixed: true,
        available: true,
        reason: '',
      });
    } else if (w) {
      const origin = t === 'enemy' ? w._enemyBasePos : w._allyBasePos;
      if (origin) {
        out.push({
          id: 'hq-' + t,
          team: t,
          x: origin.x,
          y: origin.y + 1,
          z: origin.z,
          label: '主基地',
          kind: 'hq',
          fixed: true,
          available: true,
          reason: '',
        });
      }
    }
    const flagSrc =
      this.active
        ? this.flags
        : g && g.mode === 'pvp'
          ? []
          : (w && (w._conquestFlags || w._kitFlags)) || [];
    for (let i = 0; i < flagSrc.length; i++) {
      const f = flagSrc[i];
      if (f.owner !== t) continue;
      const fullyHeld = this._isFullyHeld(f, t);
      out.push({
        id: 'flag-' + f.letter,
        team: t,
        x: f.x,
        y: f.y,
        z: f.z,
        label: f.letter + '点',
        kind: 'flag',
        letter: f.letter,
        available: fullyHeld,
        reason: fullyHeld ? '' : f.contested ? '占领点正在争夺' : '占领点尚未稳定',
      });
    }

    const squads = global.VF && global.VF.Squads;
    const player = g && g.player;
    if (squads && player && (player.team || (w && w._playerTeam) || 'ally') === t) {
      const mates = squads.getLivingSquadmates(player, g);
      for (let i = 0; i < mates.length; i++) {
        const mate = mates[i];
        if (!mate || mate === player) continue;
        const pos = mate.object ? mate.object.position : mate.mesh && mate.mesh.position;
        if (!pos) continue;
        const safe = this._deploySafety(t, mate, pos.x, pos.z);
        out.push({
          id: 'squad-' + mate.entityId,
          team: t,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          label: (mate.isSquadLeader ? '队长 ' : '小队成员 ') + (i + 1),
          kind: 'squad',
          entityId: mate.entityId,
          available: safe.available,
          reason: safe.reason,
        });
      }
    }

    const beacons =
      (global.VF.Gadgets && global.VF.Gadgets.listDeployBeacons
        ? global.VF.Gadgets.listDeployBeacons(t)
        : (w && w._deployBeacons) || []) || [];
    for (let i = 0; i < beacons.length; i++) {
      const beacon = beacons[i];
      if (!beacon || beacon.team !== t || beacon.destroyed) continue;
      const safe = this._enemyNear(t, beacon.x, beacon.z, 12)
        ? { available: false, reason: '信标受到压制' }
        : { available: true, reason: '' };
      out.push({
        id: beacon.id,
        team: t,
        x: beacon.x,
        y: beacon.y,
        z: beacon.z,
        label: '小队信标',
        kind: 'beacon',
        squadId: beacon.squadId || null,
        available: safe.available,
        reason: safe.reason,
      });
    }
    return out;
  };

  Conquest.prototype.applyDeployList = function (world, team) {
    if (!world) return [];
    const list = this.listDeployPoints(team || world._playerTeam || 'ally');
    world._deployList = list;
    const cur = world._selectedSpawnId;
    if (cur) {
      let ok = false;
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === cur && list[i].available !== false) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        let hq = null;
        for (let i = 0; i < list.length; i++) {
          if ((list[i].kind === 'hq' || list[i].fixed) && list[i].available !== false) {
            hq = list[i];
            break;
          }
        }
        world._selectedSpawnId = hq ? hq.id : list[0] ? list[0].id : null;
        if (cur.indexOf('flag-') === 0 && global.VF.UI && global.VF.UI.toast) {
          global.VF.UI.toast('占领点已丢失 · 改回主基地');
        }
      }
    }
    return list;
  };

  Conquest.prototype._syncHud = function (force) {
    if (!global.VF.UI || !global.VF.UI.updateConquestHud) return;
    const now = performance.now();
    if (!force && this._hudAt && now - this._hudAt < 120) return;
    this._hudAt = now;
    const flags = this.flags.map(function (f) {
      return {
        letter: f.letter,
        owner: f.owner,
        phase: f.phase,
        attackingTeam: f.attackingTeam,
        progress: f.progress,
        contested: f.contested,
        capture: f.capture,
        allyN: f.allyN,
        enemyN: f.enemyN,
        x: f.x,
        y: f.y,
        z: f.z,
      };
    });
    const key =
      this.tickets.ally +
      ':' +
      this.tickets.enemy +
      ':' +
      Math.floor(this.timeLeft()) +
      ':' +
      Math.floor(this._sweepAlly) +
      ':' +
      Math.floor(this._sweepEnemy) +
      ':' +
      flags
        .map(function (f) {
          return (
            f.letter +
            f.owner.charAt(0) +
            (f.contested ? 'c' : f.phase ? f.phase.charAt(0) : '') +
            Math.round((f.capture || 0) * 8)
          );
        })
        .join('');
    if (!force && key === this._lastHudKey) return;
    this._lastHudKey = key;
    const allyHeld = this._heldCount('ally');
    const enemyHeld = this._heldCount('enemy');
    global.VF.UI.updateConquestHud(this.tickets.ally, this.tickets.enemy, this.ticketsMax, flags, {
      sweepAlly: this._sweepAlly,
      sweepEnemy: this._sweepEnemy,
      sweepNeed: this.sweepSec,
      timeLeft: this.timeLeft(),
      bleedAlly: enemyHeld,
      bleedEnemy: allyHeld,
      stats: this.stats,
    });
    if (global.VF.UI && global.VF.UI.updateConquestBoard && global.VF.UI.scoreboardOpen) {
      global.VF.UI.updateConquestBoard(this);
    }
  };

  global.VF = global.VF || {};
  global.VF.Conquest = new Conquest();
  global.VF.CONQUEST = {
    TICKETS_START: TICKETS_START,
    ROUND_SEC: ROUND_SEC,
    FLAG_RADIUS: FLAG_RADIUS,
    MAX_FLAGS: MAX_FLAGS,
    DEPLOY_COUNTDOWN: DEPLOY_COUNTDOWN,
    BLEED_INTERVAL: BLEED_INTERVAL,
    SWEEP_SEC: SWEEP_SEC,
  };
})(typeof window !== 'undefined' ? window : this);
