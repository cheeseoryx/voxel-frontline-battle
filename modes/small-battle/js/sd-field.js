/**
 * sd-field.js — 爆破：世界中的炸弹实体 + 本地玩家的安装/拆除/拾取交互。
 *
 * 这是炸弹“物理侧”的单一职责模块：它把 SdBomb 的抽象状态映射到场景里的一个网格
 * （掉落 / 已安装时可见并闪烁），并把本地玩家按住 E 的输入翻译成 SdBomb 的状态转移
 * （beginPlant / cancelPlant / beginDefuse / cancelDefuse / pickup）。
 *
 * 时间推进只属于 SdBomb（由 SdMatch 每帧调用），本模块只做“意图 → 状态转移”，因此
 * 必须在 SdMatch.update 之前每帧运行一次，让玩家意图先于炸弹计时生效。它同样负责
 * “携带者阵亡即掉落”（5.4 / 3.2），对玩家与 AI 携带者一视同仁。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  function params() {
    return VF.GameModes ? VF.GameModes.getParams('demo') : {};
  }
  function attackerTeam() {
    return VF.SdMatch ? VF.SdMatch.attackerTeam : 'ally';
  }
  function dropKey() {
    return params().dropKey || 'KeyZ';
  }
  function dist2(ax, az, bx, bz) {
    const dx = ax - bx;
    const dz = az - bz;
    return dx * dx + dz * dz;
  }

  const state = {
    active: false,
    mesh: null,
    siteGroup: null,
    siteMarkers: [],
    dropSub: false,
    dropKeyHeld: false,
    gPlanting: false,
    gDefusing: false,
    gPickup: false,
    gDropKey: false,
    promptEls: null,
    promptText: null,
    promptWarn: null,
    promptProg: -2,
    lastState: null,
    flashEl: null,
    siteHud: null,
    boomRaf: 0,
    boomTimers: [],
    boomKill: null,
  };

  const Field = {
    start: function () {
      state.active = true;
      state.lastState = null;
      this._ensureMesh();
      this._hideMesh();
      this._ensureSiteMarkers();
      this._ensureSiteHud();
      this._bindDropTimeout();
      return this;
    },

    stop: function () {
      state.active = false;
      state.lastState = null;
      this._killDetonation();
      this._removeMesh();
      this._removeSiteMarkers();
      this._removeSiteHud();
      this._hidePrompt();
      this._removeFlash();
    },

    /** Run BEFORE SdMatch.update so player intent lands before the bomb ticks. */
    update: function () {
      if (!state.active) return;
      const b = VF.SdBomb;
      if (!b) return;
      const guest = this._isGuest();
      // Carrier-death → drop is a host-authoritative transition (guest mirrors it).
      if (!guest) this._dropOnCarrierLoss(b);
      if (VF.SdMatch && VF.SdMatch.scoringLive()) {
        if (guest) this._forwardGuestIntent(b);
        else this._driveLocalPlayer(b);
      }
      this._syncMesh(b);
      this._detectDetonation(b);
      this._syncPrompt(b);
      if (!state.siteGroup) this._ensureSiteMarkers();
      this._animateSites();
      this._updateSiteHud();
    },

    /* ─────────────────── PVP role: authoritative vs mirror ──────────── */

    _isGuest: function () {
      return !!(VF.SdNet && VF.SdNet.isGuest && VF.SdNet.isGuest());
    },

    /** Bomb id of THIS client's human: host sim calls the guest player 'remote'. */
    _localId: function () {
      return this._isGuest() ? 'remote' : 'player';
    },

    /* ───────────────── carrier death → bomb drops (5.4) ─────────────── */

    _dropOnCarrierLoss: function (b) {
      if (!(b.is(b.S.CARRIED) || b.is(b.S.PLANTING))) return;
      const who = this._resolveAgent(b.carrierId || b.planterId);
      if (who && who.alive) return;
      const pos = (who && who.pos) || b.dropPos || { x: 0, y: 0, z: 0 };
      b.drop(pos);
    },

    /* ─────────────────── local player interaction ──────────────────── */

    _driveLocalPlayer: function (b) {
      const g = VF.game;
      const p = g && g.player;
      if (!p || !p.object || p.alive === false || p.dead) return;
      const held = !!(p.keys && p.keys['KeyE']);
      const pos = p.object.position;
      const atk = (p.team || 'ally') === attackerTeam();

      if (atk && b.carrierId === 'player') {
        const site = this._siteWithin(pos);
        if (b.is(b.S.CARRIED)) {
          if (held && site) {
            b.beginPlant('player', site.id, { pos: { x: site.x, y: site.y, z: site.z } });
          }
        } else if (b.is(b.S.PLANTING) && b.planterId === 'player') {
          if (!(held && this._siteWithin(pos))) b.cancelPlant('release');
        }
      }

      if (!atk) {
        if (b.is(b.S.PLANTED)) {
          if (held && this._nearPlant(b, pos)) b.beginDefuse('player', !!p._sdDefuseKit);
        } else if (b.is(b.S.DEFUSING) && b.defuserId === 'player') {
          if (!(held && this._nearPlant(b, pos))) b.cancelDefuse('release');
        }
      }

      if (atk && b.is(b.S.DROPPED) && (params().pickupMode || 'auto') === 'auto') {
        if (b.canPickup() && this._nearDrop(b, pos)) b.pickup('player');
      }

      // Manual drop (3.2): the carrier taps dropKey to hand the bomb off.
      if (params().allowDrop !== false && b.is(b.S.CARRIED) && b.carrierId === 'player') {
        const dropDown = !!(p.keys && p.keys[dropKey()]);
        if (dropDown && !state.dropKeyHeld) b.drop({ x: pos.x, y: pos.y, z: pos.z });
      }
      state.dropKeyHeld = !!(p.keys && p.keys[dropKey()]);
    },

    /**
     * Guest side: never mutate the (mirrored) bomb directly — translate local
     * input edges into intents the host runs on our behalf as 'remote'. Uses
     * local key state (not the lagged mirror) for edges so it stays responsive.
     */
    _forwardGuestIntent: function (b) {
      const g = VF.game;
      const p = g && g.player;
      if (!p || !p.object || p.alive === false || p.dead) return;
      if (!VF.SdNet || !VF.SdNet.sendAct) return;
      const me = 'remote';
      const held = !!(p.keys && p.keys['KeyE']);
      const dropDown = !!(p.keys && p.keys[dropKey()]);
      const pos = p.object.position;
      const atk = (p.team || 'ally') === attackerTeam();
      const site = this._siteWithin(pos);

      // Plant / cancel (attacker carrying).
      if (atk && b.carrierId === me && b.is(b.S.CARRIED) && held && site && !state.gPlanting) {
        VF.SdNet.sendAct({ act: 'plant', site: site.id, pos: { x: site.x, y: site.y, z: site.z } });
        state.gPlanting = true;
      }
      if (state.gPlanting && (!held || !site)) {
        VF.SdNet.sendAct({ act: 'plantCancel' });
        state.gPlanting = false;
      }
      if (b.is(b.S.PLANTED) || b.isResolved()) state.gPlanting = false;

      // Defuse / cancel (defender near the planted bomb).
      if (!atk) {
        const near = this._nearPlant(b, pos);
        if (b.is(b.S.PLANTED) && held && near && !state.gDefusing) {
          VF.SdNet.sendAct({ act: 'defuse', kit: !!p._sdDefuseKit });
          state.gDefusing = true;
        }
        if (state.gDefusing && (!held || !near)) {
          VF.SdNet.sendAct({ act: 'defuseCancel' });
          state.gDefusing = false;
        }
        if (!(b.is(b.S.PLANTED) || b.is(b.S.DEFUSING))) state.gDefusing = false;
      }

      // Auto pickup (attacker standing on a dropped bomb).
      if (atk && b.is(b.S.DROPPED) && (params().pickupMode || 'auto') === 'auto') {
        if (this._nearDrop(b, pos) && !state.gPickup) {
          VF.SdNet.sendAct({ act: 'pickup' });
          state.gPickup = true;
        }
      } else {
        state.gPickup = false;
      }

      // Manual drop (dropKey edge).
      if (
        params().allowDrop !== false &&
        b.carrierId === me &&
        b.is(b.S.CARRIED) &&
        dropDown &&
        !state.gDropKey
      ) {
        VF.SdNet.sendAct({ act: 'drop', pos: { x: pos.x, y: pos.y, z: pos.z } });
      }
      state.gDropKey = dropDown;
    },

    /* ─────────────── on-screen action prompt (安装/拆除/丢弃/拾取) ────── */

    _promptEls: function () {
      if (state.promptEls) return state.promptEls;
      if (typeof document === 'undefined') return null;
      state.promptEls = {
        root: document.getElementById('sd-prompt'),
        text: document.getElementById('sd-prompt-text'),
        bar: document.getElementById('sd-prompt-bar'),
        fill: document.getElementById('sd-prompt-fill'),
      };
      return state.promptEls;
    },

    _dropKeyLabel: function () {
      const k = dropKey();
      return k && k.indexOf('Key') === 0 ? k.slice(3) : k || 'Z';
    },

    _hidePrompt: function () {
      const e = state.promptEls;
      if (e && e.root) e.root.classList.add('hidden');
      state.promptText = null;
      state.promptProg = -2;
    },

    /**
     * Contextual prompt for THIS client's human: tells the carrier where/how to
     * plant (and shows plant progress), the defender how to defuse, and hints the
     * drop / pickup keys. Reads the (possibly mirrored) bomb so it works on the
     * guest too. Pure view — never mutates bomb state.
     */
    _syncPrompt: function (b) {
      const e = this._promptEls();
      if (!e || !e.root) return;

      const g = VF.game;
      const p = g && g.player;
      const match = VF.SdMatch;
      let text = '';
      let prog = -1;
      let warn = false;

      if (p && p.object && !(p.alive === false || p.dead) && match && match.active) {
        const pos = p.object.position;
        const me = this._localId();
        const atk = (p.team || 'ally') === attackerTeam();
        const live = !!(match.scoringLive && match.scoringLive());
        const fuse = '引爆 ' + Math.max(0, Math.ceil(b.remaining)) + 's';

        if (atk) {
          if (b.is(b.S.PLANTING) && b.planterId === me) {
            text = '安装中… 按住 E';
            prog = b.plantProgress || 0;
            warn = true;
          } else if (b.is(b.S.CARRIED) && b.carrierId === me) {
            const site = this._siteWithin(pos);
            if (!live) {
              text = '准备阶段 · 出击后前往 A/B 包点安装';
            } else if (site) {
              text = '按住 E 安装炸弹（' + site.id + ' 点）';
            } else {
              text = '携带炸药 · 前往 A/B 包点 · 按 ' + this._dropKeyLabel() + ' 丢弃';
            }
          } else if (b.is(b.S.DROPPED)) {
            text = this._nearDrop(b, pos) ? '拾取炸弹中…' : '炸弹已掉落 · 靠近拾取';
            warn = true;
          }
        } else {
          if (b.is(b.S.DEFUSING) && b.defuserId === me) {
            text = '拆除中… 按住 E · ' + fuse;
            prog = b.defuseProgress || 0;
            warn = true;
          } else if (b.is(b.S.PLANTED)) {
            text =
              (this._nearPlant(b, pos) ? '按住 E 拆除炸弹 · ' : '炸弹已安装 · 靠近拆除 · ') + fuse;
            warn = true;
          }
        }
      }

      if (text !== state.promptText || warn !== state.promptWarn) {
        state.promptText = text;
        state.promptWarn = warn;
        e.text.textContent = text;
        e.root.classList.toggle('hidden', !text);
        e.root.classList.toggle('warn', warn);
      }
      if (prog !== state.promptProg) {
        state.promptProg = prog;
        if (prog >= 0) {
          if (e.bar) e.bar.classList.remove('hidden');
          if (e.fill) e.fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, prog)) + ')';
        } else if (e.bar) {
          e.bar.classList.add('hidden');
        }
      }
    },

    /* ────────────── anti-stall: dropped-too-long relocation ─────────── */

    _bindDropTimeout: function () {
      if (state.dropSub || !VF.SdBomb) return;
      state.dropSub = true;
      const self = this;
      VF.SdBomb.on('droptimeout', function (d) {
        self._onDropTimeout(d);
      });
    },

    /** Host/offline authority: shove an abandoned bomb onto the nearest site. */
    _onDropTimeout: function (d) {
      if (this._isGuest() || !VF.SdBomb) return;
      const w = VF.game && VF.game.world;
      const sites = w && w.getSdPlantSites ? w.getSdPlantSites() : [];
      if (!sites.length) return;
      const from = (d && d.pos) || VF.SdBomb.dropPos || { x: 0, z: 0 };
      let best = sites[0];
      let bestD = Infinity;
      for (let i = 0; i < sites.length; i++) {
        const dd = dist2(from.x, from.z, sites[i].x, sites[i].z);
        if (dd < bestD) {
          bestD = dd;
          best = sites[i];
        }
      }
      VF.SdBomb.relocate({ x: best.x, y: best.y != null ? best.y : 0, z: best.z });
    },

    /* ─────────────────────────── range tests ───────────────────────── */

    _siteWithin: function (pos) {
      const w = VF.game && VF.game.world;
      const sites = w && w.getSdPlantSites ? w.getSdPlantSites() : [];
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        if (dist2(pos.x, pos.z, s.x, s.z) <= s.r * s.r) return s;
      }
      return null;
    },

    _nearPlant: function (b, pos) {
      if (!b.plantPos) return false;
      const r = Math.max(params().defuseRange != null ? params().defuseRange : 1.5, 2.0);
      return dist2(pos.x, pos.z, b.plantPos.x, b.plantPos.z) <= r * r;
    },

    _nearDrop: function (b, pos) {
      if (!b.dropPos) return false;
      const r = Math.max(params().pickupRange != null ? params().pickupRange : 1.0, 1.6);
      return dist2(pos.x, pos.z, b.dropPos.x, b.dropPos.z) <= r * r;
    },

    /** Resolve a bomb participant id to its live position + alive flag. */
    _resolveAgent: function (id) {
      if (!id) return null;
      const g = VF.game;
      // This client's own human (host:'player', guest:'remote').
      if (id === this._localId()) {
        const p = g && g.player;
        if (!p) return null;
        return {
          alive: p.alive !== false && !p.dead,
          pos: p.object ? p.object.position : null,
        };
      }
      // The other human across the wire (host resolves 'remote', guest 'player').
      if (id === 'player' || id === 'remote') {
        const a = VF.SdNet && VF.SdNet.remoteAgent ? VF.SdNet.remoteAgent() : null;
        if (a) return a;
      }
      const ai = g && g.ai;
      const lists = ai ? [ai.blue, ai.red] : [];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === id) {
            return { alive: !!list[i].alive, pos: list[i].mesh ? list[i].mesh.position : null };
          }
        }
      }
      return null;
    },

    /* ────────────────────── world-space bomb mesh ──────────────────── */

    _ensureMesh: function () {
      if (state.mesh || typeof THREE === 'undefined') return;
      const g = VF.game;
      if (!g || !g.scene) return;
      const geo = new THREE.BoxGeometry(0.5, 0.35, 0.7);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x161616,
        emissive: 0xff3020,
        emissiveIntensity: 0.4,
        roughness: 0.5,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      g.scene.add(mesh);
      state.mesh = mesh;
    },

    _removeMesh: function () {
      if (state.mesh && state.mesh.parent) state.mesh.parent.remove(state.mesh);
      state.mesh = null;
    },

    _hideMesh: function () {
      if (state.mesh) state.mesh.visible = false;
    },

    _syncMesh: function (b) {
      this._ensureMesh();
      const m = state.mesh;
      if (!m) return;
      const s = b.state;
      if (s === 'carried' || s === 'planting') {
        // Prefer the local human's live position; otherwise the host-authored
        // carrierPos (mirror) so a remote/AI carrier still renders on the guest.
        const cid = b.carrierId || b.planterId;
        // 本地携带者：不渲染头顶的世界指示物——它就悬在第一人称相机上方，会挡住
        // 视野。玩家已有 HUD 图标与提示，其余客户端/AI 携带者照常显示。
        const isLocalCarrier = cid === this._localId();
        const local = isLocalCarrier ? null : this._resolveAgent(cid);
        const cp = isLocalCarrier ? null : (b.netCarrierPos || (local && local.pos) || null);
        if (cp) {
          m.visible = true;
          m.position.set(
            cp.x,
            (cp.y != null ? cp.y : 0) + 2.2 + 0.12 * Math.sin(Date.now() * 0.005),
            cp.z
          );
          m.rotation.y += 0.05;
          m.material.emissiveIntensity = s === 'planting' ? 0.75 : 0.5;
        } else {
          m.visible = false;
        }
      } else if (s === 'dropped' && b.dropPos) {
        m.visible = true;
        m.position.set(b.dropPos.x, (b.dropPos.y != null ? b.dropPos.y : 0) + 0.2, b.dropPos.z);
        m.material.emissiveIntensity = 0.4 + 0.3 * Math.sin(b.clock * 6);
      } else if ((s === 'planted' || s === 'defusing') && b.plantPos) {
        m.visible = !b.hidden || s === 'defusing';
        m.position.set(
          b.plantPos.x,
          (b.plantPos.y != null ? b.plantPos.y : 0) + 0.2,
          b.plantPos.z
        );
        const span = params().bombTimer || 45;
        const frac = b.remaining > 0 ? Math.max(0.12, b.remaining / span) : 0.12;
        m.material.emissiveIntensity = 0.5 + 0.5 * Math.sin(b.clock * (2 / frac));
      } else {
        m.visible = false;
      }
    },

    /* ─────────────────── A/B plant-site world markers ───────────────── */

    _ensureSiteMarkers: function () {
      if (state.siteGroup || typeof THREE === 'undefined') return;
      const g = VF.game;
      const w = g && g.world;
      if (!g || !g.scene || !w || !w.getSdPlantSites) return;
      const sites = w.getSdPlantSites() || [];
      if (!sites.length) return;
      const group = new THREE.Group();
      for (let i = 0; i < sites.length; i++) {
        const marker = this._buildSiteMarker(sites[i]);
        if (marker) {
          group.add(marker);
          state.siteMarkers.push(marker);
        }
      }
      g.scene.add(group);
      state.siteGroup = group;
    },

    _removeSiteMarkers: function () {
      if (state.siteGroup && state.siteGroup.parent) {
        state.siteGroup.parent.remove(state.siteGroup);
      }
      state.siteGroup = null;
      state.siteMarkers.length = 0;
    },

    /* ─────── 屏幕投影的 A/B 包点指引标签（穿墙可见，越界贴边指引） ─────── */

    _ensureSiteHud: function () {
      if (state.siteHud || typeof document === 'undefined') return;
      const w = VF.game && VF.game.world;
      const sites = w && w.getSdPlantSites ? w.getSdPlantSites() || [] : [];
      if (!sites.length) return;
      const host = document.getElementById('hud') || document.body;
      let root = document.getElementById('sd-site-hud');
      if (!root) {
        root = document.createElement('div');
        root.id = 'sd-site-hud';
        host.appendChild(root);
      }
      const markers = [];
      for (let i = 0; i < sites.length; i++) {
        const el = document.createElement('div');
        el.className = 'sd-site-marker';
        const tag = document.createElement('div');
        tag.className = 'sd-site-tag';
        tag.textContent = sites[i].id;
        const arrow = document.createElement('div');
        arrow.className = 'sd-site-arrow';
        el.appendChild(tag);
        el.appendChild(arrow);
        root.appendChild(el);
        markers.push({ id: sites[i].id, el: el });
      }
      state.siteHud = { root: root, markers: markers };
    },

    _removeSiteHud: function () {
      if (state.siteHud && state.siteHud.root && state.siteHud.root.parentNode) {
        state.siteHud.root.parentNode.removeChild(state.siteHud.root);
      }
      state.siteHud = null;
    },

    /** 每帧把 A/B 世界坐标投影到屏幕：可见则悬停在包点上方，越界/身后则贴边指引。*/
    _updateSiteHud: function () {
      const g = VF.game;
      const cam = g && g.camera;
      const w = g && g.world;
      if (!cam || !w || !w.getSdPlantSites || typeof THREE === 'undefined') return;
      if (!state.siteHud) this._ensureSiteHud();
      if (!state.siteHud) return;

      // 结算阶段隐藏（此时有回合结算横幅 / 计分板）。
      const running =
        VF.SdMatch && VF.SdMatch.active && VF.SdMatch.phase !== 'result';
      if (!running) {
        state.siteHud.root.style.display = 'none';
        return;
      }
      state.siteHud.root.style.display = '';

      const sites = w.getSdPlantSites() || [];
      const b = VF.SdBomb;
      const snap = b ? b.snapshot() : null;
      const liveSite = snap && snap.site ? String(snap.site) : null;

      if (!this._svTmp) {
        this._svTmp = new THREE.Vector3();
        this._svCam = new THREE.Vector3();
        this._svFwd = new THREE.Vector3();
        this._svDir = new THREE.Vector3();
      }
      const W = window.innerWidth;
      const H = window.innerHeight;
      cam.getWorldPosition(this._svCam);
      this._svFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);

      const markers = state.siteHud.markers;
      for (let i = 0; i < markers.length; i++) {
        const mk = markers[i];
        let site = null;
        for (let s = 0; s < sites.length; s++) {
          if (sites[s].id === mk.id) { site = sites[s]; break; }
        }
        if (!site) {
          mk.el.classList.add('hidden');
          continue;
        }
        mk.el.classList.remove('hidden');

        this._svTmp.set(site.x, (site.y != null ? site.y : 0) + 2.4, site.z);
        this._svDir.copy(this._svTmp).sub(this._svCam);
        const front = this._svDir.dot(this._svFwd) > 0;
        this._svTmp.project(cam);
        let sx = (this._svTmp.x * 0.5 + 0.5) * W;
        let sy = (-this._svTmp.y * 0.5 + 0.5) * H;
        // project() 对相机身后的点会翻转，需手动镜像并压到底边作贴边指引。
        if (!front) {
          sx = W - sx;
          sy = H - 46;
        }
        const cx = Math.max(30, Math.min(W - 30, sx));
        const cy = Math.max(96, Math.min(H - 60, sy));
        const off = !front || cx !== sx || cy !== sy;
        mk.el.style.left = cx + 'px';
        mk.el.style.top = cy + 'px';
        mk.el.classList.toggle('off', off);
        mk.el.classList.toggle('live', liveSite === mk.id);
      }
    },

    /** One site = pulsing ground ring + a faint zone column + a floating A/B tag. */
    _buildSiteMarker: function (site) {
      const color = site.id === 'A' ? 0x37b6ff : 0xffb020;
      const grp = new THREE.Group();
      grp.position.set(site.x, (site.y != null ? site.y : 0) + 0.05, site.z);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(0.5, site.r - 0.6), site.r, 40),
        new THREE.MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      grp.add(ring);

      const col = new THREE.Mesh(
        new THREE.CylinderGeometry(site.r, site.r, 2.0, 40, 1, true),
        new THREE.MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: 0.08,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      col.position.y = 1.0;
      grp.add(col);

      const label = this._makeLabelSprite(site.id, color);
      if (label) {
        // 贴地悬停：坐落于矮光柱顶端而非旧的 3.6m。过高会越过柱阵顶端，看起来像
        // 漂在红色边界（天空）里。
        label.position.y = 2.0;
        grp.add(label);
      }

      grp.userData.ring = ring;
      return grp;
    },

    /** A camera-facing letter tag drawn to a canvas — no font loader needed. */
    _makeLabelSprite: function (text, color) {
      if (typeof document === 'undefined') return null;
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const hex = '#' + ('000000' + color.toString(16)).slice(-6);
      ctx.fillStyle = 'rgba(8,10,14,0.72)';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 8;
      ctx.strokeStyle = hex;
      ctx.stroke();
      ctx.fillStyle = hex;
      ctx.font = 'bold 84px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, size / 2, size / 2 + 4);
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      const sprite = new THREE.Sprite(
        // depthTest:true 让标签被柱体/边界壳正常遮挡，而不是穿透一切浮在红色天空上。
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false })
      );
      sprite.scale.set(1.8, 1.8, 1.8);
      return sprite;
    },

    _animateSites: function () {
      const list = state.siteMarkers;
      if (!list.length) return;
      const pulse = 0.35 + 0.25 * (0.5 + 0.5 * Math.sin(Date.now() * 0.0024));
      for (let i = 0; i < list.length; i++) {
        const ring = list[i].userData && list[i].userData.ring;
        if (ring && ring.material) ring.material.opacity = pulse;
      }
    },

    /* ─────────────────────── detonation blast FX ───────────────────── */

    /** Edge-trigger: fire the blast once on the transition into 'detonated'. */
    _detectDetonation: function (b) {
      const s = b.state;
      if (s === 'detonated' && state.lastState !== 'detonated') {
        const pos =
          b.plantPos || (state.mesh && state.mesh.position) || { x: 0, y: 0, z: 0 };
        this._spawnDetonation(pos);
      }
      state.lastState = s;
    },

    /**
     * A genuinely violent explosion: white-hot core → layered fireball → rising
     * smoke/mushroom stem → expanding ground shocks → voxel debris + sparks,
     * plus a point-light burst, a full-screen flash and distance-scaled camera
     * shake. Owns its rAF loop so it can finish through the round→RESULT
     * overlay; _killDetonation() cancels it when a new match starts.
     */
    _killDetonation: function () {
      if (state.boomRaf) {
        cancelAnimationFrame(state.boomRaf);
        state.boomRaf = 0;
      }
      const timers = state.boomTimers;
      if (timers && timers.length) {
        for (let i = 0; i < timers.length; i++) clearTimeout(timers[i]);
        timers.length = 0;
      }
      if (state.boomKill) {
        const fn = state.boomKill;
        state.boomKill = null;
        try {
          fn();
        } catch (_) {}
      }
      this._removeFlash();
    },

    _spawnDetonation: function (pos) {
      const g = VF.game;
      const scene = g && g.scene;
      if (!scene || typeof THREE === 'undefined') return;
      this._killDetonation();

      const p = {
        x: pos ? pos.x : 0,
        y: pos && pos.y != null ? pos.y : 0,
        z: pos ? pos.z : 0,
      };
      this._hideMesh();
      this._screenFlash();

      const A = VF.Audio;
      if (A && A.play) {
        A.play('explosion');
        state.boomTimers = [];
        state.boomTimers.push(setTimeout(function () { if (A.play) A.play('explosion'); }, 90));
      }

      const player = g && g.player;
      const epicenter = new THREE.Vector3(p.x, p.y, p.z);
      const shake = function (mul) {
        if (!player || !player.addShake || !player.object) return;
        const d = player.object.position.distanceTo(epicenter);
        const falloff = Math.max(0, 1 - d / 120);
        if (falloff > 0) player.addShake(0.6 * falloff * mul);
      };
      shake(1);

      const basic = function (color, opacity, additive) {
        return new THREE.MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: opacity,
          depthWrite: false,
          blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
      };
      const sphere = function (r, mat, y) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 16), mat);
        m.position.set(p.x, p.y + y, p.z);
        scene.add(m);
        return m;
      };

      const light = new THREE.PointLight(0xffb060, 28, 150);
      light.position.set(p.x, p.y + 2, p.z);
      scene.add(light);

      const core = sphere(2.0, basic(0xfff2d0, 1.0, true), 1.4);
      const fire = sphere(3.4, basic(0xff7a20, 0.9, true), 1.6);
      const fire2 = sphere(5.2, basic(0xff4415, 0.72, true), 1.9);
      const smoke = sphere(6.2, basic(0x241d1a, 0.55, false), 2.2);

      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(1.0, 2.6, 10, 16, 1, true),
        basic(0xffb347, 0.5, true)
      );
      stem.position.set(p.x, p.y + 5, p.z);
      scene.add(stem);

      const rings = [];
      const ringSpec = [
        { i: 2.0, o: 4.5, c: 0xffcf70, grow: 4.4, life: 0.55 },
        { i: 4.0, o: 7.0, c: 0xff8a30, grow: 5.8, life: 0.72 },
        { i: 6.0, o: 9.5, c: 0xff4a1e, grow: 7.4, life: 0.92 },
      ];
      for (let i = 0; i < ringSpec.length; i++) {
        const rs = ringSpec[i];
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(rs.i, rs.o, 48),
          new THREE.MeshBasicMaterial({
            color: rs.c,
            transparent: true,
            opacity: 0.7,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(p.x, p.y + 0.08 + i * 0.03, p.z);
        scene.add(ring);
        rings.push({ mesh: ring, grow: rs.grow, life: rs.life, max: rs.life });
      }

      const debris = [];
      for (let i = 0; i < 140; i++) {
        const s = 0.28 + Math.random() * 0.9;
        const geo = new THREE.BoxGeometry(s, s, s * (0.7 + Math.random()));
        const c =
          i % 4 === 0 ? 0xff4422 : i % 4 === 1 ? 0xffaa44 : i % 4 === 2 ? 0x5a5450 : 0x201c1a;
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c }));
        mesh.position.set(p.x, p.y + 0.6, p.z);
        scene.add(mesh);
        const ang = Math.random() * Math.PI * 2;
        const out = 8 + Math.random() * 26;
        debris.push({
          mesh: mesh,
          geo: geo,
          vel: new THREE.Vector3(Math.cos(ang) * out, 8 + Math.random() * 20, Math.sin(ang) * out),
          spin: (Math.random() - 0.5) * 16,
          life: 1.4 + Math.random() * 1.2,
        });
      }

      const sparks = [];
      for (let i = 0; i < 46; i++) {
        const geo = new THREE.BoxGeometry(0.12, 0.12, 0.9 + Math.random());
        const mesh = new THREE.Mesh(geo, basic(0xffe08a, 1.0, true));
        mesh.position.set(p.x, p.y + 1.0, p.z);
        scene.add(mesh);
        const ang = Math.random() * Math.PI * 2;
        const elev = Math.random() * Math.PI * 0.5;
        const spd = 24 + Math.random() * 30;
        sparks.push({
          mesh: mesh,
          geo: geo,
          vel: new THREE.Vector3(
            Math.cos(ang) * Math.cos(elev) * spd,
            Math.sin(elev) * spd + 6,
            Math.sin(ang) * Math.cos(elev) * spd
          ),
          life: 0.35 + Math.random() * 0.4,
          max: 0.75,
        });
      }

      const floor = p.y + 0.2;
      const start = performance.now();
      let lastShake = 0;
      let dead = false;
      const tick = function () {
        if (dead) return;
        const age = (performance.now() - start) / 1000;
        const dt = 0.016;

        if (age < 0.55 && age - lastShake > 0.08) {
          shake(0.5);
          lastShake = age;
        }

        const uc = Math.min(1, age / 0.3);
        core.scale.setScalar(1 + uc * 3);
        core.material.opacity = Math.max(0, 1 - uc);
        const uf = Math.min(1, age / 0.6);
        fire.scale.setScalar(1 + uf * 2.4);
        fire.material.opacity = Math.max(0, 0.9 - uf);
        fire2.scale.setScalar(1 + uf * 2.0);
        fire2.material.opacity = Math.max(0, 0.72 - uf * 0.82);
        const us = Math.min(1, age / 1.4);
        smoke.scale.setScalar(1 + us * 1.8);
        smoke.position.y = p.y + 2.2 + us * 4.5;
        smoke.material.opacity = Math.max(0, 0.55 - us * 0.55);
        const ut = Math.min(1, age / 0.7);
        stem.scale.set(1 + ut * 0.6, 1 + ut * 1.2, 1 + ut * 0.6);
        stem.position.y = p.y + 5 + ut * 3;
        stem.material.opacity = Math.max(0, 0.5 - ut * 0.5);

        for (let i = 0; i < rings.length; i++) {
          const r = rings[i];
          r.life -= dt;
          const u = 1 - Math.max(0, r.life) / r.max;
          r.mesh.scale.set(1 + u * r.grow, 1, 1 + u * r.grow);
          r.mesh.material.opacity = Math.max(0, 0.7 * (1 - u));
        }

        for (let i = debris.length - 1; i >= 0; i--) {
          const o = debris[i];
          o.life -= dt;
          o.vel.y -= 30 * dt;
          o.mesh.position.addScaledVector(o.vel, dt);
          if (o.mesh.position.y < floor && o.vel.y < 0) {
            o.mesh.position.y = floor;
            o.vel.y *= -0.32;
            o.vel.x *= 0.6;
            o.vel.z *= 0.6;
          }
          o.mesh.rotation.x += o.spin * dt;
          o.mesh.rotation.z += o.spin * 0.7 * dt;
          if (o.life <= 0) {
            scene.remove(o.mesh);
            o.geo.dispose();
            o.mesh.material.dispose();
            debris.splice(i, 1);
          }
        }

        for (let i = sparks.length - 1; i >= 0; i--) {
          const o = sparks[i];
          o.life -= dt;
          o.vel.y -= 26 * dt;
          o.mesh.position.addScaledVector(o.vel, dt);
          o.mesh.material.opacity = Math.max(0, o.life / o.max);
          if (o.life <= 0) {
            scene.remove(o.mesh);
            o.geo.dispose();
            o.mesh.material.dispose();
            sparks.splice(i, 1);
          }
        }

        light.intensity *= 0.86;
        light.position.y = p.y + 2 + Math.min(6, age * 8);

        if (age < 3.0 && (debris.length > 0 || sparks.length > 0 || age < 1.5)) {
          state.boomRaf = requestAnimationFrame(tick);
          return;
        }

        kill();
      };

      const kill = function () {
        if (dead) return;
        dead = true;
        if (state.boomRaf) {
          cancelAnimationFrame(state.boomRaf);
          state.boomRaf = 0;
        }
        const timers = state.boomTimers;
        if (timers && timers.length) {
          for (let i = 0; i < timers.length; i++) clearTimeout(timers[i]);
          timers.length = 0;
        }
        const drop = [core, fire, fire2, smoke, stem];
        for (let i = 0; i < drop.length; i++) {
          scene.remove(drop[i]);
          drop[i].geometry.dispose();
          drop[i].material.dispose();
        }
        for (let i = 0; i < rings.length; i++) {
          scene.remove(rings[i].mesh);
          rings[i].mesh.geometry.dispose();
          rings[i].mesh.material.dispose();
        }
        for (let i = 0; i < debris.length; i++) {
          scene.remove(debris[i].mesh);
          debris[i].geo.dispose();
          debris[i].mesh.material.dispose();
        }
        debris.length = 0;
        for (let i = 0; i < sparks.length; i++) {
          scene.remove(sparks[i].mesh);
          sparks[i].geo.dispose();
          sparks[i].mesh.material.dispose();
        }
        sparks.length = 0;
        scene.remove(light);
        if (state.boomKill === kill) state.boomKill = null;
      };
      state.boomKill = kill;
      state.boomRaf = requestAnimationFrame(tick);
    },

    /** Brief full-screen blast flash (over HUD, under nothing that needs input). */
    _screenFlash: function () {
      if (typeof document === 'undefined') return;
      let el = state.flashEl;
      if (!el) {
        el = document.createElement('div');
        el.style.cssText =
          'position:fixed;inset:0;z-index:1090;pointer-events:none;opacity:0;' +
          'background:radial-gradient(circle at 50% 46%, rgba(255,240,210,0.95),' +
          ' rgba(255,150,60,0.5) 40%, rgba(120,40,10,0.16) 70%, rgba(0,0,0,0) 100%);';
        document.body.appendChild(el);
        state.flashEl = el;
      }
      el.style.transition = 'none';
      el.style.opacity = '0.92';
      void el.offsetWidth;
      el.style.transition = 'opacity 0.55s ease-out';
      el.style.opacity = '0';
    },

    _removeFlash: function () {
      if (state.flashEl && state.flashEl.parentNode) {
        state.flashEl.parentNode.removeChild(state.flashEl);
      }
      state.flashEl = null;
    },
  };

  VF.SdField = Field;
})(typeof window !== 'undefined' ? window : globalThis);