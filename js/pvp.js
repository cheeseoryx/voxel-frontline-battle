/**
 * pvp.js — 1v1 rooms + shared battlefield sync
 * Transport: localStorage bus (same PC) + PeerJS (optional).
 * Phases: lobby → prep → spawnWait → play
 */
(function (global) {
  'use strict';

  const PEER_PREFIX = 'vf1v1';
  const BUS_PREFIX = 'vf_pvp_bus_';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const BUS_TTL_MS = 10000;
  const PEER_OPTS = {
    debug: 0,
    secure: true,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ],
    },
  };
  const CONN_OPTS = { reliable: true, serialization: 'json' };

  function randomCode(len) {
    len = len || 6;
    let s = '';
    for (let i = 0; i < len; i++) {
      s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    }
    return s;
  }

  const Pvp = {
    mode: null,
    roomCode: null,
    peer: null,
    conn: null,
    connected: false,
    localReady: false,
    remoteReady: false,
    remotePresent: false,
    matchSeed: null,
    phase: null, // lobby | prep | spawnWait | play
    _lobbyDone: false,
    _battlefieldEntered: false,
    _onMatchStart: null,
    _onEnterBattlefield: null,
    _onSpawnGateBack: null,
    _destroyed: false,
    _busTimer: null,
    _busClientId: null,
    _onStorage: null,
    _pendingStart: null,
    _pendingEnter: null,
    spawnReadyLocal: false,
    spawnReadyRemote: false,
    localLoadout: null,
    remoteLoadout: null,
    remoteState: null,
    remoteAvatar: null,
    _lastStateSend: 0,

    els: null,

    init(onMatchStart) {
      this._onMatchStart = onMatchStart;
      this._busClientId =
        'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      this.els = {
        joinOverlay: document.getElementById('pvp-join-overlay'),
        lobbyOverlay: document.getElementById('pvp-lobby-overlay'),
        joinCode: document.getElementById('pvp-join-code'),
        joinErr: document.getElementById('pvp-join-err'),
        joinBtn: document.getElementById('pvp-join-confirm'),
        joinBack: document.getElementById('pvp-join-back'),
        lobbyCode: document.getElementById('pvp-lobby-code'),
        lobbyStatus: document.getElementById('pvp-lobby-status'),
        lobbyRole: document.getElementById('pvp-lobby-role'),
        youReady: document.getElementById('pvp-you-ready'),
        foeReady: document.getElementById('pvp-foe-ready'),
        readyBtn: document.getElementById('pvp-ready-btn'),
        startBtn: document.getElementById('pvp-start-btn'),
        copyBtn: document.getElementById('pvp-copy-btn'),
        lobbyBack: document.getElementById('pvp-lobby-back'),
        createBtn: document.getElementById('pvp-create-btn'),
        openJoinBtn: document.getElementById('pvp-open-join-btn'),
        matchReadyOverlay: document.getElementById('pvp-match-ready-overlay'),
        matchReadyStatus: document.getElementById('pvp-match-ready-status'),
        matchYouReady: document.getElementById('pvp-match-you-ready'),
        matchYouReadyBadge: document.getElementById('pvp-match-you-ready-badge'),
        matchFoeReady: document.getElementById('pvp-match-foe-ready'),
        matchFoeReadyBadge: document.getElementById('pvp-match-foe-ready-badge'),
        matchReadyBtn: document.getElementById('pvp-match-ready-btn'),
        matchReadyBack: document.getElementById('pvp-match-ready-back'),
        matchFoeInfo: document.getElementById('pvp-match-foe-info'),
        matchYouClass: document.getElementById('pvp-match-you-class'),
        matchFoeClass: document.getElementById('pvp-match-foe-class'),
        matchYouCanvas: document.getElementById('pvp-match-you-canvas'),
        matchFoeCanvas: document.getElementById('pvp-match-foe-canvas'),
      };

      const bind = (el, fn) => {
        if (el)
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            fn();
          });
      };
      bind(this.els.createBtn, () => this.createRoom());
      bind(this.els.openJoinBtn, () => this.openJoin());
      bind(this.els.joinBack, () => this.closeJoin());
      bind(this.els.joinBtn, () => this.joinRoom());
      bind(this.els.lobbyBack, () => this.leaveLobby());
      bind(this.els.readyBtn, () => this.toggleReady());
      bind(this.els.startBtn, () => this.hostStartMatch());
      bind(this.els.copyBtn, () => this.copyCode());
      bind(this.els.matchReadyBtn, () => this.toggleSpawnReady());
      bind(this.els.matchReadyBack, () => this.cancelSpawnGate());
      if (this.els.joinCode) {
        this.els.joinCode.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.joinRoom();
          }
        });
      }

      this._setupKubeeBridge();
    },

    /** Kubee iframe bridge (本地开发包 threejs-3d-multiplayer) */
    _setupKubeeBridge() {
      if (!global.VF_KUBEE || !global.VF_KUBEE.active) return;
      if (this._kubeeBound) return;
      this._kubeeBound = true;
      this._kubee = true;
      global.VF_KUBEE.onNet((msg) => this._onKubeeMessage(msg));
      if (this._setStatus) this._setStatus('Kubee 联机模式 · 等待房间分配…');
    },

    _onKubeeMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'kubee-lobby') {
        this._applyKubeeLobby(msg);
        return;
      }
      if (msg.type === 'kubee-welcome') {
        if (msg.playerId) this._busClientId = 'k_' + msg.playerId;
        return;
      }
      if (msg.type === 'kubee-net') {
        const payload = msg.payload;
        if (payload && payload.type === 'vf' && payload.payload) {
          this._onData(payload.payload);
        } else if (payload) {
          this._onData(payload);
        }
        return;
      }
      if (msg.type === 'kubee-disconnected') {
        this.remotePresent = false;
        this.connected = false;
        this._updateStatusFromFlags();
        this._refreshLobby();
      }
    },

    _applyKubeeLobby(msg) {
      const players = msg.players || [];
      const others = players.filter((p) => p.id && p.id !== msg.playerId);
      const kubeePaired = others.length > 0;

      let role = null;
      if (kubeePaired) {
        role = msg.role === 'guest' ? 'guest' : msg.role === 'host' ? 'host' : null;
      }
      if (!role) role = this._electKubeeRoleFromBus();

      this._destroyed = false;
      this._kubee = true;
      this.mode = role;
      this.phase =
        this.phase === 'play' || this.phase === 'prep' || this.phase === 'spawnWait'
          ? this.phase
          : 'lobby';
      this.roomCode = 'KUBEE';
      this._hideCover();
      this._openLobbyUI();
      if (this.els.lobbyCode) this.els.lobbyCode.textContent = 'KUBEE';
      if (this.els.copyBtn) this.els.copyBtn.classList.add('hidden');
      if (this.els.lobbyRole) {
        this.els.lobbyRole.textContent =
          '1v1 · Kubee · ' + (this.mode === 'host' ? '房主' : '访客');
      }

      this._startBus();
      this._busPublish();
      this._ingestBus();

      if (kubeePaired) {
        this.remotePresent = true;
        this.connected = true;
      }
      this._setStatus(
        this.remotePresent
          ? '已连上对手 · 双方准备后由房主开始'
          : '等待另一窗口进入联机大厅…（同机请再开一个 localhost:15180）'
      );
      this._refreshLobby();
      this._send({ type: 'hello', role: this.mode, ready: this.localReady });
    },

    /**
     * First claimer becomes host; second becomes guest.
     * Shared localStorage lock so two tabs on one PC never both stay host.
     */
    _electKubeeRoleFromBus() {
      const LOCK_KEY = 'vf_kubee_seat';
      const now = Date.now();
      let seat = null;
      try {
        seat = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
      } catch (_) {
        seat = null;
      }
      const seatFresh = !!(seat && seat.hostId && now - (seat.ts || 0) < BUS_TTL_MS);
      if (!seatFresh) {
        seat = { hostId: this._busClientId, ts: now };
        try {
          localStorage.setItem(LOCK_KEY, JSON.stringify(seat));
        } catch (_) {}
        try {
          seat = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null') || seat;
        } catch (_) {}
      }
      if (seat && seat.hostId === this._busClientId) {
        seat.ts = now;
        try {
          localStorage.setItem(LOCK_KEY, JSON.stringify(seat));
        } catch (_) {}
        return 'host';
      }
      return 'guest';
    },

    _isKubee() {
      return !!(this._kubee || (global.VF_KUBEE && global.VF_KUBEE.active));
    },

    /** Alias used by AI / HUD — same as mode (host|guest) */
    get role() {
      return this.mode;
    },

    /** Kubee: enter lobby using role from shell / local bus. */
    _enterKubeeLobby() {
      this._destroyed = false;
      this._kubee = true;
      this.roomCode = 'KUBEE';
      this.phase = 'lobby';
      this.localReady = false;
      this.remoteReady = false;
      this.remotePresent = false;
      this.connected = false;
      this._lobbyDone = false;
      this._battlefieldEntered = false;
      this._pendingStart = null;
      this._pendingEnter = null;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;
      this.mode = this._electKubeeRoleFromBus();
      this._hideCover();
      this._openLobbyUI();
      if (this.els.lobbyCode) this.els.lobbyCode.textContent = 'KUBEE';
      if (this.els.copyBtn) this.els.copyBtn.classList.add('hidden');
      if (this.els.lobbyRole) {
        this.els.lobbyRole.textContent =
          '1v1 · Kubee · ' + (this.mode === 'host' ? '房主' : '访客');
      }
      this._startBus();
      this._busPublish();
      this._ingestBus();
      this._setStatus('Kubee 联机 · 等待另一窗口进入…');
      if (global.VF_KUBEE && global.VF_KUBEE.lobby) {
        this._applyKubeeLobby(global.VF_KUBEE.lobby);
      } else if (global.VF_KUBEE) {
        global.VF_KUBEE.pingParent();
      }
      this._updateStatusFromFlags();
      this._refreshLobby();
    },

    /** Re-broadcast lobby presence (used when backing out of class select). */
    _sendLobbySync() {
      this._busPublish();
      this._send({ type: 'hello', role: this.mode, ready: this.localReady });
    },

    _hideCover() {
      const o = document.getElementById('start-overlay');
      if (o) o.classList.add('hidden');
      if (global.VF.Hub) global.VF.Hub.hide();
    },

    _showCover() {
      if (global.VF.Hub) {
        global.VF.Hub.resume();
        return;
      }
      const o = document.getElementById('start-overlay');
      if (o) o.classList.remove('hidden');
    },

    _ensurePeerJs() {
      return typeof Peer !== 'undefined';
    },

    _busKey() {
      return BUS_PREFIX + (this.roomCode || '');
    },

    _readBus() {
      try {
        const raw = localStorage.getItem(this._busKey());
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    },

    listServers() {
      const out = [];
      const now = Date.now();
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || key.indexOf(BUS_PREFIX) !== 0) continue;
          const suffix = key.slice(BUS_PREFIX.length);
          if (!suffix || /^(builds_|core_|dead_|dmg_)/.test(suffix)) continue;
          let state = null;
          try {
            state = JSON.parse(localStorage.getItem(key) || 'null');
          } catch (_) {
            state = null;
          }
          if (!state || !state.code || !state.host) continue;
          if (now - (state.host.ts || 0) >= BUS_TTL_MS) continue;
          const guestAlive = !!(
            state.guest &&
            now - (state.guest.ts || 0) < BUS_TTL_MS
          );
          out.push({
            code: String(state.code),
            name:
              (state.server && state.server.name) ||
              '社区对战服务器 [' + String(state.code) + ']',
            map: (state.server && state.server.map) || '裂脊谷',
            mode: (state.server && state.server.mode) || 'conquest',
            modeLabel: (state.server && state.server.modeLabel) || '征服',
            size: 2,
            sizeLabel: '32 v 32',
            players: 1 + (guestAlive ? 1 : 0),
            capacity: 2,
            ping: Math.max(1, Math.min(999, now - (state.host.ts || now))),
            official: false,
            password: false,
            phase: state.phase || 'lobby',
            createdAt: (state.server && state.server.createdAt) || state.ts || now,
          });
        }
      } catch (_) {}
      out.sort(function (a, b) {
        return b.createdAt - a.createdAt;
      });
      return out;
    },

    joinRoomCode(code) {
      if (!this.els || !this.els.joinCode) return false;
      this.els.joinCode.value = String(code || '').trim().toUpperCase();
      this.joinRoom();
      return true;
    },

    _writeBus(state) {
      try {
        localStorage.setItem(this._busKey(), JSON.stringify(state));
      } catch (_) {}
    },

    _startBus() {
      this._stopBus();
      this._onStorage = (e) => {
        if (!e) return;
        if (e.key === this._busKey()) this._ingestBus();
        if (e.key === this._dmgKey()) this._pollDamageBus();
        if (e.key === this._buildLogKey()) this._pollBuildBus();
      };
      window.addEventListener('storage', this._onStorage);
      this._busTimer = setInterval(() => {
        if (this._destroyed || !this.roomCode) return;
        this._busPublish();
        this._ingestBus();
        this._pollDamageBus();
        this._pollBuildBus();
      }, 120);
      this._busPublish();
      this._ingestBus();
    },

    _stopBus() {
      if (this._busTimer) {
        clearInterval(this._busTimer);
        this._busTimer = null;
      }
      if (this._onStorage) {
        window.removeEventListener('storage', this._onStorage);
        this._onStorage = null;
      }
    },

    _busPublish() {
      if (!this.roomCode || !this.mode) return;
      const prev = this._readBus() || {};
      const now = Date.now();
      const next = {
        v: 2,
        code: this.roomCode,
        ts: now,
        phase: this.phase || 'lobby',
        server:
          prev.server || {
            name: '社区对战服务器 [' + this.roomCode + ']',
            map: '裂脊谷',
            mode: 'conquest',
            modeLabel: '征服',
            createdAt: now,
          },
        host: prev.host || null,
        guest: prev.guest || null,
        start: prev.start || null,
        enter: prev.enter || null,
      };
      const slot = {
        id: this._busClientId,
        ready: !!this.localReady,
        spawnReady: !!this.spawnReadyLocal,
        phase: this.phase || 'lobby',
        ts: now,
      };
      if (this.localLoadout) {
        slot.classId = this.localLoadout.classId;
        slot.spawnId = this.localLoadout.spawnId;
        slot.team = this.localLoadout.team;
      }
      if (this._playState) {
        slot.x = this._playState.x;
        slot.y = this._playState.y;
        slot.z = this._playState.z;
        slot.yaw = this._playState.yaw;
        slot.hp = this._playState.hp;
        slot.alive = this._playState.alive;
        slot.crouch = !!this._playState.crouch;
        slot.stealth = !!this._playState.stealth;
      }
      if (this.mode === 'host') next.host = slot;
      else next.guest = slot;

      if (this.mode === 'host' && this._pendingStart) next.start = this._pendingStart;
      if (this.mode === 'host' && this._pendingEnter) next.enter = this._pendingEnter;
      if (this.mode === 'host' && this._matchHud) next.matchHud = this._matchHud;
      if (this.mode === 'host' && this._pendingWinner) next.winner = this._pendingWinner;

      // Merge build events — append-only by id (avoid last-write wiping peer builds)
      let builds = Array.isArray(prev.builds) ? prev.builds.slice() : [];
      const have = Object.create(null);
      for (let i = 0; i < builds.length; i++) {
        if (builds[i] && builds[i].id) have[builds[i].id] = 1;
      }
      try {
        const log = JSON.parse(localStorage.getItem(this._buildLogKey()) || '[]');
        if (Array.isArray(log)) {
          for (let i = 0; i < log.length; i++) {
            const b = log[i];
            if (b && b.id && !have[b.id]) {
              builds.push(b);
              have[b.id] = 1;
            }
          }
        }
      } catch (_) {}
      if (this._outgoingBuilds && this._outgoingBuilds.length) {
        for (let i = 0; i < this._outgoingBuilds.length; i++) {
          const b = this._outgoingBuilds[i];
          if (b && b.id && !have[b.id]) {
            builds.push(b);
            have[b.id] = 1;
          }
        }
        this._outgoingBuilds = [];
      }
      if (builds.length > 80) builds = builds.slice(-80);
      next.builds = builds;

      this._writeBus(next);
    },

    _ingestBus() {
      if (!this.roomCode || !this.mode) return;
      const state = this._readBus();
      if (!state) return;
      const now = Date.now();

      // Kubee same-PC: if two tabs both claimed host, demote the later id to guest
      if (
        this._isKubee() &&
        this.phase === 'lobby' &&
        this.mode === 'host' &&
        state.host &&
        state.host.id &&
        state.host.id !== this._busClientId &&
        now - (state.host.ts || 0) < BUS_TTL_MS
      ) {
        if (String(this._busClientId) > String(state.host.id)) {
          this.mode = 'guest';
          try {
            localStorage.setItem(
              'vf_kubee_seat',
              JSON.stringify({ hostId: state.host.id, ts: now })
            );
          } catch (_) {}
          this._openLobbyUI();
          this._busPublish();
        }
      }

      const other = this.mode === 'host' ? state.guest : state.host;
      const otherAlive = !!(other && now - (other.ts || 0) < BUS_TTL_MS);
      const peerUp = !!(this.conn && this.conn.open);

      if (otherAlive) {
        this.remotePresent = true;
        this.connected = true;
        this.remoteReady = !!other.ready;
        this.spawnReadyRemote = !!other.spawnReady;
        if (other.classId || other.spawnId || other.team) {
          this.remoteLoadout = {
            classId: other.classId || 'assault',
            spawnId: other.spawnId || null,
            team: other.team || (this.mode === 'host' ? 'enemy' : 'ally'),
          };
        }
        if (other.x != null) {
          this.remoteState = {
            x: other.x,
            y: other.y,
            z: other.z,
            yaw: other.yaw || 0,
            hp: other.hp != null ? other.hp : 100,
            alive: other.alive !== false,
            crouch: !!other.crouch,
            stealth: !!other.stealth,
            classId: other.classId || (this.remoteLoadout && this.remoteLoadout.classId) || 'assault',
            team: other.team || (this.remoteLoadout && this.remoteLoadout.team),
          };
        }
      } else if (!peerUp) {
        if (this.phase === 'lobby') {
          this.remotePresent = false;
          this.remoteReady = false;
        }
        this.spawnReadyRemote = false;
      }

      // Lobby start (guest)
      if (!this._lobbyDone && this.mode === 'guest' && state.start && state.start.seed) {
        this.matchSeed = state.start.seed;
        this._beginMatchFromNet(state.start);
        return;
      }

      // Shared battlefield enter
      if (
        this._lobbyDone &&
        !this._battlefieldEntered &&
        state.enter &&
        state.enter.seed
      ) {
        this._enterBattlefield(state.enter);
        return;
      }

      // Authoritative match HUD (timer + core HP)
      if (this.phase === 'play' && state.matchHud) {
        this._applyMatchHud(state.matchHud);
      }

      // Winner payload
      if (state.winner && state.winner.winnerTeam) {
        this.declareWinner(state.winner.winnerTeam, state.winner.reason || '');
      }

      // Builds on main bus
      if (this.phase === 'play' && state.builds && state.builds.length) {
        for (let i = 0; i < state.builds.length; i++) {
          this._applyRemoteBuild(state.builds[i]);
        }
      }

      // Incoming damage from opponent (separate bus key)
      this._pollDamageBus();
      this._pollCoreDmgBus();
      this._pollBuildBus();

      // Host: both spawn-ready → publish enter
      if (
        this._lobbyDone &&
        !this._battlefieldEntered &&
        this.phase === 'spawnWait' &&
        this.mode === 'host' &&
        this.spawnReadyLocal &&
        this.spawnReadyRemote
      ) {
        this._hostPublishEnter();
        return;
      }

      if (!this._lobbyDone) {
        this._updateStatusFromFlags();
        this._refreshLobby();
      } else if (this.phase === 'spawnWait') {
        this._refreshMatchReadyUI();
      }
    },

    _updateStatusFromFlags() {
      if (this._lobbyDone) return;
      if (!this.remotePresent) {
        if (this.localReady) {
          this._setStatus(
            this.mode === 'host'
              ? '你已准备 · 仍在等待对手加入'
              : '你已准备 · 等待连上房主…'
          );
        } else if (this.mode === 'host') {
          this._setStatus('等待对手加入… 把房间码发给对方');
        }
        return;
      }
      if (this.localReady && this.remoteReady) {
        this._setStatus(
          this.mode === 'host'
            ? '双方已准备 · 点击「开始对局」'
            : '双方已准备 · 等待房主开始'
        );
      } else if (this.localReady) {
        this._setStatus('你已准备 · 等待对手准备');
      } else if (this.remoteReady) {
        this._setStatus('对手已准备 · 请点击准备');
      } else {
        this._setStatus('对手已加入 · 双方准备后由房主开始');
      }
    },

    openJoin() {
      if (this._isKubee()) {
        this._enterKubeeLobby();
        return;
      }
      this._hideCover();
      if (this.els.joinErr) this.els.joinErr.textContent = '';
      if (this.els.joinCode) this.els.joinCode.value = '';
      if (this.els.joinOverlay) this.els.joinOverlay.classList.remove('hidden');
      setTimeout(() => {
        if (this.els.joinCode) this.els.joinCode.focus();
      }, 50);
    },

    closeJoin() {
      if (this.els.joinOverlay) this.els.joinOverlay.classList.add('hidden');
      this._showCover();
    },

    createRoom() {
      if (this._isKubee()) {
        this._enterKubeeLobby();
        return;
      }
      this.destroySession();
      this.mode = 'host';
      this.phase = 'lobby';
      this.localReady = false;
      this.remoteReady = false;
      this.remotePresent = false;
      this.connected = false;
      this._lobbyDone = false;
      this._battlefieldEntered = false;
      this._pendingStart = null;
      this._pendingEnter = null;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;
      this.roomCode = randomCode(6);
      this._hideCover();
      this._openLobbyUI();
      this._setStatus('房间已创建 · 等待对手加入…');
      this._startBus();

      if (!this._ensurePeerJs()) {
        this._setStatus('房间已创建（本机同步）· 等待对手用房间码加入');
        return;
      }

      const peerId = PEER_PREFIX + this.roomCode;
      try {
        this.peer = new Peer(peerId, PEER_OPTS);
      } catch (_) {
        this._setStatus('Peer 创建失败，仍可用本机房间码联机');
        return;
      }

      this.peer.on('open', () => {
        this._setStatus('等待对手加入… 把房间码发给对方');
        this._refreshLobby();
      });
      this.peer.on('error', (err) => {
        const msg = (err && err.type) || (err && err.message) || 'error';
        if (msg === 'unavailable-id') {
          this.createRoom();
          return;
        }
        this._setStatus('Peer 异常（' + msg + '），本机同步仍可用');
      });
      this.peer.on('connection', (conn) => {
        if (this.conn && this.conn.open) {
          conn.close();
          return;
        }
        this._bindConn(conn);
      });
    },

    joinRoom() {
      if (this._isKubee()) {
        this._enterKubeeLobby();
        return;
      }
      const raw = (this.els.joinCode && this.els.joinCode.value) || '';
      const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 4) {
        if (this.els.joinErr) this.els.joinErr.textContent = '请输入有效房间码';
        return;
      }
      if (this.els.joinErr) this.els.joinErr.textContent = '';

      this.destroySession();
      this.mode = 'guest';
      this.phase = 'lobby';
      this.roomCode = code;
      this.localReady = false;
      this.remoteReady = false;
      this.remotePresent = false;
      this.connected = false;
      this._lobbyDone = false;
      this._battlefieldEntered = false;
      this._pendingStart = null;
      this._pendingEnter = null;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;

      if (this.els.joinOverlay) this.els.joinOverlay.classList.add('hidden');
      this._openLobbyUI();
      this._setStatus('正在加入房间 ' + code + '…');
      this._startBus();

      const bus = this._readBus();
      if (bus && bus.host && Date.now() - (bus.host.ts || 0) < BUS_TTL_MS) {
        this.remotePresent = true;
        this.connected = true;
        this.remoteReady = !!bus.host.ready;
        this._setStatus('已加入房间 · 请双方准备');
        this._busPublish();
        this._refreshLobby();
      } else {
        this._setStatus('等待房主… 请确认房间码正确且房主在大厅');
        this._busPublish();
      }

      if (!this._ensurePeerJs()) return;
      try {
        this.peer = new Peer(PEER_OPTS);
      } catch (_) {
        return;
      }
      this.peer.on('open', () => {
        try {
          this._bindConn(this.peer.connect(PEER_PREFIX + code, CONN_OPTS));
        } catch (_) {}
      });
    },

    _bindConn(conn) {
      if (!conn) return;
      if (this.conn && this.conn !== conn) {
        try {
          this.conn.close();
        } catch (_) {}
      }
      this.conn = conn;
      const onOpen = () => {
        this.connected = true;
        this.remotePresent = true;
        this._send({ type: 'hello', role: this.mode, ready: this.localReady });
        this._busPublish();
        this._refreshLobby();
      };
      if (conn.open) onOpen();
      else conn.on('open', onOpen);
      conn.on('data', (data) => this._onData(data));
      conn.on('close', () => {
        if (this.conn !== conn) return;
        this.conn = null;
        this._ingestBus();
      });
    },

    _onData(data) {
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (_) {
          return;
        }
      }
      if (!data || typeof data !== 'object') return;
      switch (data.type) {
        case 'hello':
          this.connected = true;
          this.remotePresent = true;
          if (typeof data.ready === 'boolean') this.remoteReady = data.ready;
          this._updateStatusFromFlags();
          this._refreshLobby();
          break;
        case 'ready':
          this.remoteReady = !!data.ready;
          this._updateStatusFromFlags();
          this._refreshLobby();
          break;
        case 'spawnReady':
          this.spawnReadyRemote = !!data.ready;
          if (data.loadout) this.remoteLoadout = data.loadout;
          this._refreshMatchReadyUI();
          if (
            this.mode === 'host' &&
            this.spawnReadyLocal &&
            this.spawnReadyRemote
          ) {
            this._hostPublishEnter();
          }
          break;
        case 'enter':
          this._enterBattlefield(data);
          break;
        case 'state':
          this.remoteState = data;
          break;
        case 'build':
          this._applyRemoteBuild(data);
          break;
        case 'break':
          this._applyRemoteBreak(data);
          break;
        case 'damage':
          if (data.id && data.id === this._lastDamageKey) break;
          if (data.id) this._lastDamageKey = data.id;
          this._applyIncomingDamage(data.dmg || 0);
          break;
        case 'coreDmg':
          if (this.mode === 'host') {
            this._hostApplyCoreDamage(data.attackerTeam, data.dmg);
          }
          break;
        case 'hud':
          this._applyMatchHud(data);
          break;
        case 'winner':
          this.declareWinner(data.winnerTeam, data.reason || '');
          break;
        case 'playerDead':
          // Opponent fell — hide remote until they redeploy (core destroy still wins)
          if (this.remoteState) {
            this.remoteState.alive = false;
            this.remoteState.hp = 0;
          }
          this._lastRemoteAlive = false;
          break;
        case 'conquest-snapshot':
        case 'conquest-snapshot-request':
        case 'conquest-command':
          if (global.VF.NetSimulation && global.VF.NetSimulation.receive) {
            global.VF.NetSimulation.receive(data);
          }
          break;
        case 'start':
          if (!this._lobbyDone) {
            this.matchSeed = data.seed || Date.now();
            this._beginMatchFromNet(data);
          }
          break;
        case 'leave':
          this.remotePresent = false;
          this.remoteReady = false;
          this.spawnReadyRemote = false;
          this._setStatus('对手已离开房间');
          this._refreshLobby();
          this._refreshMatchReadyUI();
          break;
        default:
          break;
      }
    },

    _send(obj) {
      if (this.conn && this.conn.open) {
        try {
          this.conn.send(obj);
        } catch (_) {}
      }
      // Kubee room relay (本地开发包)
      if (this._isKubee() && global.VF_KUBEE && global.VF_KUBEE.send) {
        try {
          global.VF_KUBEE.send(obj);
        } catch (_) {}
      }
    },

    toggleReady() {
      this.localReady = !this.localReady;
      this._send({ type: 'ready', ready: this.localReady });
      this._busPublish();
      this._updateStatusFromFlags();
      this._refreshLobby();
    },

    _linkOk() {
      return !!(
        this.remotePresent ||
        (this.conn && this.conn.open) ||
        (this._isKubee() && this.remotePresent)
      );
    },

    hostStartMatch() {
      if (this.mode !== 'host' || this._lobbyDone) return;
      this._ingestBus();
      if (!this._linkOk()) {
        this._toast('对手尚未加入');
        return;
      }
      if (!this.localReady || !this.remoteReady) {
        this._toast('双方都准备后才能开始');
        return;
      }
      const seed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
      this.matchSeed = seed;
      const payload = {
        type: 'start',
        seed: seed,
        hostTeam: 'ally',
        guestTeam: 'enemy',
        fromId: this._busClientId,
      };
      this._pendingStart = payload;
      this._busPublish();
      this._send(payload);
      this._beginMatchFromNet(payload);
    },

    _beginMatchFromNet(data) {
      if (this._lobbyDone) return;
      this._lobbyDone = true;
      this.phase = 'prep';
      this.localReady = false;
      this.remoteReady = false;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;
      // Keep bus alive for spawn gate + play sync
      if (this.els.lobbyOverlay) this.els.lobbyOverlay.classList.add('hidden');
      const isHost = this.mode === 'host';
      if (typeof this._onMatchStart === 'function') {
        this._onMatchStart({
          mode: 'pvp',
          role: this.mode,
          roomCode: this.roomCode,
          seed: data.seed || this.matchSeed,
          team: isHost ? data.hostTeam || 'ally' : data.guestTeam || 'enemy',
          isHost: isHost,
        });
      }
      this._busPublish();
    },

    /** After spawn select: wait until both players ready, then enter same match */
    openSpawnGate(loadout, onEnter, onBack) {
      this.phase = 'spawnWait';
      this.localLoadout = loadout || null;
      this.spawnReadyLocal = false;
      this._onEnterBattlefield = onEnter;
      this._onSpawnGateBack = onBack;
      this._battlefieldEntered = false;
      this._pendingEnter = null;
      this._busPublish();
      this._send({
        type: 'spawnReady',
        ready: false,
        loadout: this.localLoadout,
      });
      if (this.els.matchReadyOverlay) {
        this.els.matchReadyOverlay.classList.remove('hidden');
      }
      this._startMatchPreviews();
      this._refreshMatchReadyUI();
    },

    toggleSpawnReady() {
      if (this.phase !== 'spawnWait' || this._battlefieldEntered) return;
      this.spawnReadyLocal = !this.spawnReadyLocal;
      this._busPublish();
      this._send({
        type: 'spawnReady',
        ready: this.spawnReadyLocal,
        loadout: this.localLoadout,
      });
      this._refreshMatchReadyUI();
      if (
        this.mode === 'host' &&
        this.spawnReadyLocal &&
        this.spawnReadyRemote
      ) {
        this._hostPublishEnter();
      }
    },

    cancelSpawnGate() {
      this.spawnReadyLocal = false;
      this.phase = 'prep';
      this._busPublish();
      this._stopMatchPreviews();
      if (this.els.matchReadyOverlay) {
        this.els.matchReadyOverlay.classList.add('hidden');
      }
      if (typeof this._onSpawnGateBack === 'function') this._onSpawnGateBack();
    },

    _hostPublishEnter() {
      if (this.mode !== 'host' || this._battlefieldEntered) return;
      if (!this.spawnReadyLocal || !this.spawnReadyRemote) return;
      const payload = {
        type: 'enter',
        seed: this.matchSeed || Date.now(),
        t: Date.now(),
        fromId: this._busClientId,
      };
      this._pendingEnter = payload;
      this._busPublish();
      this._send(payload);
      this._enterBattlefield(payload);
    },

    _enterBattlefield(data) {
      if (this._battlefieldEntered) return;
      this._battlefieldEntered = true;
      this.phase = 'play';
      this.matchTime = 0;
      this._matchEnded = false;
      this._pendingWinner = null;
      this._matchHud = {
        time: 0,
        allyHp: 1000,
        enemyHp: 1000,
        winner: null,
      };
      this._lastRemoteAlive = true;
      this._seenBuildIds = Object.create(null);
      this._outgoingBuilds = [];
      this._stopMatchPreviews();
      if (this.els.matchReadyOverlay) {
        this.els.matchReadyOverlay.classList.add('hidden');
      }
      if (typeof this._onEnterBattlefield === 'function') {
        this._onEnterBattlefield({
          seed: (data && data.seed) || this.matchSeed,
          remoteLoadout: this.remoteLoadout,
        });
      }
    },

    _classLabel(classId) {
      const list = global.VF && global.VF.Soldier && global.VF.Soldier.CLASSES;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === classId) {
            return list[i].nameZh || list[i].nameEn || list[i].label || classId;
          }
        }
      }
      return classId || '—';
    },

    _teamLabel(team) {
      return team === 'enemy' ? '红方' : '蓝方';
    },

    _setReadyEl(el, text, ready) {
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('is-ready', !!ready);
    },

    _refreshMatchReadyUI() {
      const youReadyTxt = this.spawnReadyLocal ? '已准备' : '未准备';
      const foeReadyTxt = this.spawnReadyRemote
        ? '已准备'
        : this.remotePresent
          ? '未准备'
          : '等待中…';

      this._setReadyEl(this.els.matchYouReady, youReadyTxt, this.spawnReadyLocal);
      this._setReadyEl(this.els.matchYouReadyBadge, youReadyTxt, this.spawnReadyLocal);
      this._setReadyEl(this.els.matchFoeReady, foeReadyTxt, this.spawnReadyRemote);
      this._setReadyEl(this.els.matchFoeReadyBadge, foeReadyTxt, this.spawnReadyRemote);

      if (this.els.matchReadyBtn) {
        this.els.matchReadyBtn.textContent = this.spawnReadyLocal
          ? '取消准备'
          : '准备进入';
      }

      const ll = this.localLoadout;
      if (this.els.matchYouClass) {
        this.els.matchYouClass.textContent = ll
          ? this._teamLabel(ll.team) + ' · ' + this._classLabel(ll.classId)
          : '—';
      }

      const rl = this.remoteLoadout;
      if (this.els.matchFoeClass) {
        this.els.matchFoeClass.textContent = rl
          ? this._teamLabel(rl.team) + ' · ' + this._classLabel(rl.classId)
          : '等待中…';
      }
      if (this.els.matchFoeInfo) {
        this.els.matchFoeInfo.textContent = rl
          ? '对手：' + this._teamLabel(rl.team) + ' · ' + this._classLabel(rl.classId)
          : '对手选点同步中…';
      }

      if (this.els.matchReadyStatus) {
        if (this.spawnReadyLocal && this.spawnReadyRemote) {
          this.els.matchReadyStatus.textContent =
            this.mode === 'host'
              ? '双方就绪 · 正在进入同一战场…'
              : '双方就绪 · 等待同步进入…';
        } else if (this.spawnReadyLocal) {
          this.els.matchReadyStatus.textContent = '已准备 · 等待对手准备进入';
        } else {
          this.els.matchReadyStatus.textContent =
            '选点完成 · 双方都点「准备进入」后进入同一战场';
        }
      }

      this._syncMatchPreviewModels();
    },

    _startMatchPreviews() {
      this._stopMatchPreviews();
      if (!global.THREE || !global.VF || !global.VF.Soldier) return;
      if (!this.els.matchYouCanvas || !this.els.matchFoeCanvas) return;

      const scene = new THREE.Scene();
      scene.background = null;
      const cam = new THREE.PerspectiveCamera(36, 3 / 4, 0.1, 40);
      cam.position.set(1.35, 1.35, 4.6);
      cam.lookAt(0.15, 1.05, 0);
      const light = new THREE.DirectionalLight(0xfff0dd, 1.25);
      light.position.set(2.2, 5.5, 4);
      scene.add(light);
      scene.add(new THREE.AmbientLight(0x99aabb, 0.85));
      const fill = new THREE.DirectionalLight(0xaaccff, 0.4);
      fill.position.set(-3, 2, 2);
      scene.add(fill);

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);

      this._matchPreview = {
        scene: scene,
        cam: cam,
        renderer: renderer,
        youModel: null,
        foeModel: null,
        youKey: '',
        foeKey: '',
        raf: 0,
        t0: performance.now(),
      };
      this._syncMatchPreviewModels();

      const self = this;
      const tick = () => {
        if (!self._matchPreview || self.phase !== 'spawnWait') return;
        const prev = self._matchPreview;
        const t = (performance.now() - prev.t0) * 0.001;
        // Face camera-ish with slow sway so arms + rifle stay readable
        self._paintMatchPreview(
          self.els.matchYouCanvas,
          prev.youModel,
          0.55 + Math.sin(t * 0.65) * 0.4
        );
        self._paintMatchPreview(
          self.els.matchFoeCanvas,
          prev.foeModel,
          -0.55 + Math.sin(t * 0.65 + 1.2) * 0.4
        );
        prev.raf = requestAnimationFrame(tick);
      };
      this._matchPreview.raf = requestAnimationFrame(tick);
    },

    _paintMatchPreview(canvas, model, rotY) {
      const prev = this._matchPreview;
      if (!prev || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(2, Math.floor(rect.width));
      const h = Math.max(2, Math.floor(rect.height));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      prev.renderer.setSize(w, h, false);
      prev.cam.aspect = w / h;
      // Fit full body
      const midY = 1.05;
      const bodyH = 2.4;
      const vFov = THREE.MathUtils.degToRad(prev.cam.fov);
      let dist = (bodyH * 0.5) / Math.tan(vFov * 0.5);
      dist *= 1.15;
      prev.cam.position.set(0, midY, dist);
      prev.cam.lookAt(0, midY, 0);
      prev.cam.updateProjectionMatrix();

      if (prev.youModel) prev.youModel.visible = false;
      if (prev.foeModel) prev.foeModel.visible = false;
      if (model) {
        model.visible = true;
        model.position.set(0, 0, 0);
        model.rotation.set(0, rotY, 0);
      }
      prev.renderer.render(prev.scene, prev.cam);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(prev.renderer.domElement, 0, 0, w, h);
      }
      if (model) model.visible = false;
    },

    _makePreviewModel(classId, team) {
      const Soldier = global.VF.Soldier;
      let m;
      if (Soldier.createClassSoldier) {
        m = Soldier.createClassSoldier(classId || 'assault', {
          team: team || 'ally',
        });
      } else {
        m = Soldier.createPreviewSoldier(classId || 'assault');
      }
      const marker = m.getObjectByName('TeamMarker');
      if (marker) m.remove(marker);
      // Keep weapon + combat arms visible on the sync screen
      const gun = m.getObjectByName('Weapon');
      if (gun) gun.visible = true;
      m.visible = false;
      return m;
    },

    _syncMatchPreviewModels() {
      const prev = this._matchPreview;
      if (!prev || !prev.scene) return;
      const ll = this.localLoadout;
      const rl = this.remoteLoadout;
      const youKey =
        (ll && ll.classId ? ll.classId : 'assault') +
        '|' +
        (ll && ll.team ? ll.team : 'ally');
      const foeKey = rl
          ? (rl.classId || 'assault') + '|' + (rl.team || 'enemy')
        : '';

      if (youKey !== prev.youKey) {
        if (prev.youModel) prev.scene.remove(prev.youModel);
        prev.youModel = this._makePreviewModel(
          ll && ll.classId,
          ll && ll.team
        );
        prev.scene.add(prev.youModel);
        prev.youKey = youKey;
      }

      if (foeKey !== prev.foeKey) {
        if (prev.foeModel) {
          prev.scene.remove(prev.foeModel);
          prev.foeModel = null;
        }
        if (foeKey) {
          prev.foeModel = this._makePreviewModel(
            rl.classId,
            rl.team
          );
          prev.scene.add(prev.foeModel);
        }
        prev.foeKey = foeKey;
      }
    },

    _stopMatchPreviews() {
      const prev = this._matchPreview;
      if (!prev) return;
      if (prev.raf) cancelAnimationFrame(prev.raf);
      if (prev.youModel && prev.scene) prev.scene.remove(prev.youModel);
      if (prev.foeModel && prev.scene) prev.scene.remove(prev.foeModel);
      if (prev.renderer) {
        try {
          prev.renderer.dispose();
        } catch (_) {}
      }
      this._matchPreview = null;
    },

    /** Call from game loop while running */
    publishPlayState(state) {
      if (this.phase !== 'play' || !state) return;
      this._playState = state;
      const now = performance.now();
      if (now - this._lastStateSend > 50) {
        this._lastStateSend = now;
        this._busPublish();
        this._send({
          type: 'state',
          x: state.x,
          y: state.y,
          z: state.z,
          yaw: state.yaw,
          hp: state.hp,
          alive: state.alive,
          crouch: !!state.crouch,
          classId: state.classId,
          team: state.team,
          stealth: !!state.stealth,
        });
      }
    },

    /**
     * Host: advance match clock + broadcast timer/core HP.
     * Guest: apply bus HUD (already in ingest) and detect remote death.
     */
    tickMatch(dt, game) {
      if (this.phase !== 'play' || this._matchEnded) return;
      if (!game) return;
      if (global.VF.Conquest && global.VF.Conquest.active) return;

      // Track remote alive for avatar visibility — death no longer ends the match
      if (this.remoteState && this.remoteState.alive === false) {
        this._lastRemoteAlive = false;
      } else if (this.remoteState && this.remoteState.alive !== false) {
        this._lastRemoteAlive = true;
      }

      if (this.mode !== 'host') return;

      this.matchTime = (this.matchTime || 0) + dt;
      const bases = game.bases;
      const allyHp =
        bases && bases.allyBase ? bases.allyBase.userData.coreHp : 1000;
      const enemyHp =
        bases && bases.enemyBase ? bases.enemyBase.userData.coreHp : 1000;

      this._matchHud = {
        time: this.matchTime,
        allyHp: allyHp,
        enemyHp: enemyHp,
        winner: null,
        t: Date.now(),
      };

      if (global.VF.UI) {
        global.VF.UI.updateWave(1, this.matchTime);
        if (bases && bases._refreshCoreHud) bases._refreshCoreHud();
      }

      const now = performance.now();
      if (!this._lastHudSend || now - this._lastHudSend > 150) {
        this._lastHudSend = now;
        this._busPublish();
        this._send({
          type: 'hud',
          time: this.matchTime,
          allyHp: allyHp,
          enemyHp: enemyHp,
        });
      }
    },

    _applyMatchHud(hud) {
      if (!hud || this._matchEnded) return;
      if (this.mode === 'host') return; // host is source of truth
      if (hud.time != null && global.VF.UI) {
        this.matchTime = hud.time;
        global.VF.UI.updateWave(1, hud.time);
      }
      const game = global.VF.game;
      if (
        game &&
        game.bases &&
        game.bases.applyPvpCoreHp &&
        hud.allyHp != null &&
        hud.enemyHp != null
      ) {
        game.bases.applyPvpCoreHp(hud.allyHp, hud.enemyHp);
      }
      if (hud.winner) {
        this.declareWinner(hud.winner, hud.reason || '');
      }
    },

    _pollBuildBus() {
      if (this.phase !== 'play' || !this.roomCode) return;
      try {
        const raw = localStorage.getItem(this._buildLogKey());
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return;
        for (let i = 0; i < arr.length; i++) {
          const evt = arr[i];
          if (!evt || !evt.id) continue;
          if (evt.fromId === this._busClientId) continue;
          this._applyRemoteBuild(evt);
        }
      } catch (_) {}
    },

    _applyRemoteBuild(data) {
      if (!data || !data.kind) return;
      if (data.fromId && data.fromId === this._busClientId) return;
      if (!data.matchSeed || String(data.matchSeed) !== String(this.matchSeed)) return;
      // Voxel / door destruction piggybacks on the build bus
      if (
        data.kind === 'break-voxel' ||
        data.kind === 'break-door' ||
        data.kind === 'deform-terrain'
      ) {
        this._applyRemoteBreak(data);
        return;
      }
      if (!this._seenBuildIds) this._seenBuildIds = Object.create(null);
      if (data.id && this._seenBuildIds[data.id]) return;
      if (data.id) this._seenBuildIds[data.id] = 1;

      const game = global.VF && global.VF.game;
      if (game && game.building && game.building.applyNetworkBuild) {
        try {
          game.building.applyNetworkBuild(data);
        } catch (err) {
          console.warn('[PVP] applyNetworkBuild failed', err);
          if (data.id) delete this._seenBuildIds[data.id];
        }
      }
    },

    _applyRemoteBreak(data) {
      if (!data) return;
      if (data.fromId && data.fromId === this._busClientId) return;
      if (!data.matchSeed || String(data.matchSeed) !== String(this.matchSeed)) return;
      if (!this._seenBuildIds) this._seenBuildIds = Object.create(null);
      if (data.id && this._seenBuildIds[data.id]) return;
      if (data.id) this._seenBuildIds[data.id] = 1;

      const game = global.VF && global.VF.game;
      const world = game && game.world;
      if (!world) {
        if (data.id) delete this._seenBuildIds[data.id];
        return;
      }
      try {
        if (data.kind === 'deform-terrain' && world.deformTerrainCircle) {
          world.deformTerrainCircle(data.x, data.z, data.radius, data.depth, {
            maxDepth: 1.2,
            maxNeighborDelta: 0.8,
          });
        } else if (data.kind === 'break-door' && world.destroyDoorNear) {
          world.destroyDoorNear(data.x, data.y, data.z);
        } else if (world.breakBlock) {
          world.breakBlock(data.x, data.y, data.z, { force: true });
        }
      } catch (err) {
        console.warn('[PVP] applyRemoteBreak failed', err);
        if (data.id) delete this._seenBuildIds[data.id];
      }
    },

    _buildLogKey() {
      return BUS_PREFIX + 'builds_' + (this.roomCode || '') + '_' + (this.matchSeed || 'none');
    },

    /** Sync terrain edits (broken voxels / doors) to the other player */
    sendWorldBreak(payload) {
      if (!payload || !this.roomCode) return;
      if (this.phase !== 'play' && this.phase !== 'spawnWait') return;

      const deform = payload.kind === 'deform-terrain';
      const evt = {
        type: 'break',
        kind: deform
          ? 'deform-terrain'
          : payload.kind === 'break-door'
            ? 'break-door'
            : 'break-voxel',
        x: deform ? +payload.x : payload.x | 0,
        y: deform ? 0 : payload.y | 0,
        z: deform ? +payload.z : payload.z | 0,
        radius: deform ? +payload.radius : undefined,
        depth: deform ? +payload.depth : undefined,
        matchSeed: this.matchSeed,
        t: Date.now(),
        fromId: this._busClientId,
        id:
          this._busClientId +
          '_k_' +
          Date.now() +
          '_' +
          Math.random().toString(36).slice(2, 7),
      };

      this._send(evt);

      if (!this._outgoingBuilds) this._outgoingBuilds = [];
      this._outgoingBuilds.push(evt);
      while (this._outgoingBuilds.length > 48) this._outgoingBuilds.shift();
      this._busPublish();

      try {
        const key = this._buildLogKey();
        let arr = [];
        try {
          arr = JSON.parse(localStorage.getItem(key) || '[]');
        } catch (_) {
          arr = [];
        }
        if (!Array.isArray(arr)) arr = [];
        arr.push(evt);
        while (arr.length > 80) arr.shift();
        localStorage.setItem(key, JSON.stringify(arr));
      } catch (err) {
        console.warn('[PVP] break log write failed', err);
      }
    },

    sendBuild(payload) {
      if (!payload) return;
      // Allow slightly early sync if phase lag; still require room
      if (!this.roomCode) return;
      if (this.phase !== 'play' && this.phase !== 'spawnWait') return;

      const evt = Object.assign({}, payload, {
        type: 'build',
        matchSeed: this.matchSeed,
        t: Date.now(),
        fromId: this._busClientId,
        id:
          this._busClientId +
          '_b_' +
          Date.now() +
          '_' +
          Math.random().toString(36).slice(2, 7),
      });

      // Compact design for storage / peer size limits
      if (evt.design && evt.design.cells) {
        try {
          const raw = JSON.stringify(evt.design);
          if (raw.length > 180000) {
            evt.design = {
              cells: evt.design.cells,
              ziplines: evt.design.ziplines || [],
              w: evt.design.w,
              h: evt.design.h,
              d: evt.design.d,
            };
          }
        } catch (_) {}
      }

      this._send(evt);

      // Main bus queue (survives peer failure)
      if (!this._outgoingBuilds) this._outgoingBuilds = [];
      this._outgoingBuilds.push(evt);
      while (this._outgoingBuilds.length > 24) this._outgoingBuilds.shift();
      this._busPublish();

      // Dedicated log (backup)
      try {
        const key = this._buildLogKey();
        let arr = [];
        try {
          arr = JSON.parse(localStorage.getItem(key) || '[]');
        } catch (_) {
          arr = [];
        }
        if (!Array.isArray(arr)) arr = [];
        arr.push(evt);
        while (arr.length > 48) arr.shift();
        localStorage.setItem(key, JSON.stringify(arr));
      } catch (err) {
        console.warn('[PVP] build log write failed', err);
      }
    },

    sendCoreDamage(attackerTeam, dmg) {
      if (!(dmg > 0) || this._matchEnded) return;
      const evt = {
        type: 'coreDmg',
        attackerTeam: attackerTeam,
        dmg: Math.round(dmg),
        t: Date.now(),
        fromId: this._busClientId,
        id:
          this._busClientId +
          '_c_' +
          Date.now() +
          '_' +
          Math.random().toString(36).slice(2, 6),
      };
      this._send(evt);
      try {
        localStorage.setItem(this._coreDmgKey(), JSON.stringify(evt));
      } catch (_) {}
    },

    _coreDmgKey() {
      return BUS_PREFIX + 'core_' + (this.roomCode || '');
    },

    _pollCoreDmgBus() {
      if (this.mode !== 'host' || this.phase !== 'play' || !this.roomCode) return;
      try {
        const raw = localStorage.getItem(this._coreDmgKey());
        if (!raw) return;
        const evt = JSON.parse(raw);
        if (!evt || !evt.id || evt.fromId === this._busClientId) return;
        if (evt.id === this._lastCoreDmgKey) return;
        if (Date.now() - (evt.t || 0) > 3000) return;
        this._lastCoreDmgKey = evt.id;
        this._hostApplyCoreDamage(evt.attackerTeam, evt.dmg);
      } catch (_) {}
    },

    _hostApplyCoreDamage(attackerTeam, dmg) {
      if (this.mode !== 'host' || this._matchEnded) return;
      const game = global.VF.game;
      if (!game || !game.bases || !game.bases._applyCoreDamage) return;
      game.bases._applyCoreDamage(attackerTeam, dmg);
    },

    reportLocalDeath() {
      if (this._matchEnded) return;
      const game = global.VF.game;
      const myTeam =
        (game && game.player && game.player.team) ||
        (game && game.world && game.world._playerTeam) ||
        (this.mode === 'host' ? 'ally' : 'enemy');
      this._send({ type: 'playerDead', team: myTeam });
      // Push a final dead pose so the opponent hides our avatar until redeploy
      if (game && game.player && game.player.object) {
        const pos = game.player.object.position;
        this.publishPlayState({
          x: pos.x,
          y: pos.y,
          z: pos.z,
          yaw: game.player.yaw || 0,
          hp: 0,
          alive: false,
          crouch: false,
          classId: game.player.classId || 'assault',
          team: myTeam,
          stealth: false,
        });
      }
      try {
        localStorage.setItem(
          this._coreDmgKey().replace('core_', 'dead_'),
          JSON.stringify({
            team: myTeam,
            t: Date.now(),
            fromId: this._busClientId,
            id: this._busClientId + '_dead_' + Date.now(),
          })
        );
      } catch (_) {}
    },

    declareWinner(winnerTeam, reason) {
      if (this._matchEnded) return;
      if (winnerTeam !== 'ally' && winnerTeam !== 'enemy') return;
      this._matchEnded = true;
      reason = reason || '';
      this._pendingWinner = {
        winnerTeam: winnerTeam,
        reason: reason,
        t: Date.now(),
        fromId: this._busClientId,
      };
      this._matchHud = this._matchHud || {};
      this._matchHud.winner = winnerTeam;
      this._matchHud.reason = reason;
      this._matchHud.time = this.matchTime || 0;
      this._busPublish();
      this._send({
        type: 'winner',
        winnerTeam: winnerTeam,
        reason: reason,
        time: this.matchTime || 0,
      });
      this._showMatchEnd(winnerTeam, reason);
    },

    _showMatchEnd(winnerTeam, reason) {
      const game = global.VF.game;
      if (game) game.running = false;
      document.exitPointerLock && document.exitPointerLock();

      if (game && game.bases) {
        const myTeam =
          (game.player && game.player.team) ||
          (game.world && game.world._playerTeam) ||
          'ally';
        game.bases.won = myTeam === winnerTeam;
        game.bases.lost = myTeam !== winnerTeam;
      }

      // Prefer victory overlay for both (not death panel)
      if (global.VF.UI && global.VF.UI.els && global.VF.UI.els.deathOverlay) {
        global.VF.UI.els.deathOverlay.classList.add('hidden');
      }

      const title = winnerTeam === 'ally' ? '蓝方胜利' : '红方胜利';
      let sub = reason || '对局结束';
      if (game && game.bases && global.VF.Economy && global.VF.Economy.grantMatchReward) {
        const won = !!game.bases.won;
        const reward = global.VF.Economy.grantMatchReward('pvp', won);
        const line =
          global.VF.Economy.formatRewardLine && global.VF.Economy.formatRewardLine(reward);
        if (line) sub = sub + ' · ' + line;
      }
      if (global.VF.UI && global.VF.UI.showVictory) {
        global.VF.UI.showVictory(title, sub);
      }
    },

    ensureRemoteAvatar(scene) {
      if (!scene || !global.THREE || !global.VF || !global.VF.Soldier) return null;
      const classId =
        (this.remoteState && this.remoteState.classId) ||
        (this.remoteLoadout && this.remoteLoadout.classId) ||
        'assault';
      const team =
        (this.remoteState && this.remoteState.team) ||
        (this.remoteLoadout && this.remoteLoadout.team) ||
        (this.mode === 'host' ? 'enemy' : 'ally');

      if (
        this.remoteAvatar &&
        this.remoteAvatar.classId === classId &&
        this.remoteAvatar.team === team
      ) {
        return this.remoteAvatar;
      }

      this.removeRemoteAvatar(scene);
      const mesh = global.VF.Soldier.createClassSoldier(classId, { team: team });
      mesh.name = 'RemotePlayer';
      mesh.rotation.order = 'YXZ';
      scene.add(mesh);
      this.remoteAvatar = {
        mesh: mesh,
        classId: classId,
        team: team,
        _tx: 0,
        _ty: 8,
        _tz: 0,
        _tyaw: 0,
      };
      return this.remoteAvatar;
    },

    removeRemoteAvatar(scene) {
      if (this.remoteAvatar && this.remoteAvatar.mesh) {
        if (scene) scene.remove(this.remoteAvatar.mesh);
        this.remoteAvatar.mesh = null;
      }
      this.remoteAvatar = null;
    },

    /** Player yaw matches soldier facing after model face-fix (eyes on -Z). */
    _faceYawFromPlayerYaw(yaw) {
      return yaw || 0;
    },

    updateRemoteAvatar(scene, dt) {
      if (this.phase !== 'play') return;
      const st = this.remoteState;
      if (!st || st.x == null) return;
      const av = this.ensureRemoteAvatar(scene);
      if (!av || !av.mesh) return;
      av._tx = st.x;
      av._ty = st.y;
      av._tz = st.z;
      av._tyaw = this._faceYawFromPlayerYaw(st.yaw);
      const m = av.mesh;
      const k = Math.min(1, (dt || 0.016) * 14);
      m.position.x += (av._tx - m.position.x) * k;
      m.position.y += (av._ty - m.position.y) * k;
      m.position.z += (av._tz - m.position.z) * k;
      let dy = av._tyaw - m.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      m.rotation.y += dy * k;
      m.visible = st.alive !== false && !st.stealth;
      if (global.VF.Soldier) {
        if (global.VF.Soldier.setCrouchPose) {
          global.VF.Soldier.setCrouchPose(m, !!st.crouch);
        }
        if (global.VF.Soldier.updateCrouchPose) {
          global.VF.Soldier.updateCrouchPose(m, dt);
        }
      }
    },

    /** Capsule raycast vs remote player. Returns { point, dist } or null. */
    raycastRemote(origin, dir, range) {
      if (this.phase !== 'play') return null;
      const st = this.remoteState;
      // Stealthed remotes stay hittable (fair PvP) but are invisible
      if (!st || st.x == null || st.alive === false) return null;
      const av = this.remoteAvatar;
      const px = av && av.mesh ? av.mesh.position.x : st.x;
      const py = av && av.mesh ? av.mesh.position.y : st.y;
      const pz = av && av.mesh ? av.mesh.position.z : st.z;
      const crouchT = st.crouch ? 1 : 0;
      const centerY = py + (1.15 - crouchT * 0.45);
      const hitR = 1.15 - crouchT * 0.3;
      const center = new THREE.Vector3(px, centerY, pz);
      const to = center.clone().sub(origin);
      const proj = to.dot(dir);
      if (proj < 0 || proj > range) return null;
      const closest = origin.clone().addScaledVector(dir, proj);
      if (closest.distanceTo(center) > hitR) return null;
      return { point: closest, dist: proj };
    },

    /** Deal damage to the remote player (networked). */
    dealDamageToRemote(dmg) {
      if (this.phase !== 'play' || !(dmg > 0)) return;
      dmg = Math.round(dmg);
      const evt = {
        dmg: dmg,
        t: Date.now(),
        fromId: this._busClientId,
        id: this._busClientId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      };
      this._send({ type: 'damage', dmg: dmg, id: evt.id });
      try {
        localStorage.setItem(this._dmgKey(), JSON.stringify(evt));
      } catch (_) {}
      // Optimistic local feedback on remote avatar
      if (this.remoteState) {
        this.remoteState.hp = Math.max(
          0,
          (this.remoteState.hp != null ? this.remoteState.hp : 100) - dmg
        );
        if (this.remoteState.hp <= 0) this.remoteState.alive = false;
      }
      if (this.remoteAvatar && this.remoteAvatar.mesh) {
        this.remoteAvatar.mesh.traverse((c) => {
          if (c.isMesh && c.material && c.material.emissive) {
            c.material.emissive.setHex(0xff2200);
            setTimeout(() => {
              if (c.material) c.material.emissive.setHex(0x000000);
            }, 70);
          }
        });
      }
    },

    _dmgKey() {
      return BUS_PREFIX + 'dmg_' + (this.roomCode || '');
    },

    _pollDamageBus() {
      if (this.phase !== 'play' || !this.roomCode) return;
      try {
        const raw = localStorage.getItem(this._dmgKey());
        if (!raw) return;
        const evt = JSON.parse(raw);
        if (!evt || !evt.id || evt.fromId === this._busClientId) return;
        if (evt.id === this._lastDamageKey) return;
        if (Date.now() - (evt.t || 0) > 3000) return;
        this._lastDamageKey = evt.id;
        this._applyIncomingDamage(evt.dmg || 0);
      } catch (_) {}
    },

    _applyIncomingDamage(dmg) {
      const game = global.VF && global.VF.game;
      if (!game || !game.player || game.mode !== 'pvp') return;
      if (!(dmg > 0)) return;
      const from =
        this.remoteAvatar && this.remoteAvatar.mesh
          ? this.remoteAvatar.mesh.position
          : this.remoteState
            ? { x: this.remoteState.x, y: this.remoteState.y, z: this.remoteState.z }
            : null;
      if (game.player.takeDamage) game.player.takeDamage(dmg, from);
      else {
        game.player.health = Math.max(0, game.player.health - dmg);
        if (global.VF.UI) {
          global.VF.UI.updateVitals(game.player.health, game.player.armor);
        }
      }
    },

    _openLobbyUI() {
      if (this.els.lobbyCode) this.els.lobbyCode.textContent = this.roomCode || '------';
      if (this.els.lobbyRole) {
        this.els.lobbyRole.textContent =
          this.mode === 'host' ? '你是房主 · 蓝方' : '你是访客 · 红方';
      }
      if (this.els.lobbyOverlay) this.els.lobbyOverlay.classList.remove('hidden');
      this._refreshLobby();
    },

    _canHostStart() {
      return !!(
        this.mode === 'host' &&
        this._linkOk() &&
        this.localReady &&
        this.remoteReady &&
        !this._lobbyDone
      );
    },

    _refreshLobby() {
      if (this.els.youReady) {
        this.els.youReady.textContent = this.localReady ? '已准备' : '未准备';
        this.els.youReady.classList.toggle('is-ready', this.localReady);
      }
      if (this.els.foeReady) {
        if (!this.remotePresent) {
          this.els.foeReady.textContent = '等待中…';
          this.els.foeReady.classList.remove('is-ready');
        } else {
          this.els.foeReady.textContent = this.remoteReady ? '已准备' : '未准备';
          this.els.foeReady.classList.toggle('is-ready', this.remoteReady);
        }
      }
      if (this.els.readyBtn) {
        this.els.readyBtn.textContent = this.localReady ? '取消准备' : '准备';
      }
      if (this.els.startBtn) {
        const show = this.mode === 'host';
        this.els.startBtn.classList.toggle('hidden', !show);
        this.els.startBtn.disabled = false;
        this.els.startBtn.style.opacity = this._canHostStart() ? '1' : '0.55';
      }
      if (this.els.copyBtn) {
        this.els.copyBtn.classList.toggle('hidden', this.mode !== 'host');
      }
    },

    _setStatus(text) {
      if (this.els.lobbyStatus) this.els.lobbyStatus.textContent = text;
    },

    copyCode() {
      const code = this.roomCode || '';
      if (!code) return;
      const done = () => this._toast('房间码已复制：' + code);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done).catch(() => {
          this._fallbackCopy(code);
          done();
        });
      } else {
        this._fallbackCopy(code);
        done();
      }
    },

    _fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch (_) {}
      document.body.removeChild(ta);
    },

    leaveLobby() {
      this._send({ type: 'leave' });
      try {
        const state = this._readBus();
        if (state && this.mode) {
          if (this.mode === 'host') state.host = null;
          else state.guest = null;
          state.start = null;
          state.enter = null;
          this._writeBus(state);
        }
      } catch (_) {}
      this._stopMatchPreviews();
      const scene = global.VF && global.VF.game && global.VF.game.scene;
      this.removeRemoteAvatar(scene);
      this.destroySession();
      if (this.els.lobbyOverlay) this.els.lobbyOverlay.classList.add('hidden');
      if (this.els.joinOverlay) this.els.joinOverlay.classList.add('hidden');
      if (this.els.matchReadyOverlay) {
        this.els.matchReadyOverlay.classList.add('hidden');
      }
      this._showCover();
    },

    destroySession() {
      this._destroyed = true;
      this._stopBus();
      this._pendingStart = null;
      this._pendingEnter = null;
      this._playState = null;
      try {
        if (this.conn) this.conn.close();
      } catch (_) {}
      try {
        if (this.peer) this.peer.destroy();
      } catch (_) {}
      this.conn = null;
      this.peer = null;
      this.connected = false;
      this.remotePresent = false;
      this.localReady = false;
      this.remoteReady = false;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;
      this.localLoadout = null;
      this.remoteLoadout = null;
      this.remoteState = null;
      this.mode = null;
      this.roomCode = null;
      this.phase = null;
      this._lobbyDone = false;
      this._battlefieldEntered = false;
      this._matchEnded = false;
      this._pendingWinner = null;
      this._matchHud = null;
      this.matchTime = 0;
      this._destroyed = false;
    },

    _toast(msg) {
      if (global.VF && global.VF.UI && global.VF.UI.toast) global.VF.UI.toast(msg);
    },
  };

  global.VF = global.VF || {};
  global.VF.Pvp = Pvp;
})(typeof window !== 'undefined' ? window : globalThis);
