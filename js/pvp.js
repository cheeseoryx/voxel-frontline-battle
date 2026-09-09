/**
 * pvp.js — 8v8 human rooms + shared battlefield sync
 * Transport: localStorage bus (same PC) + PeerJS (optional).
 * Host creates and enters play immediately; joiners drop into the live match.
 */
(function (global) {
  'use strict';

  const PEER_PREFIX = 'vf1v1';
  const BUS_PREFIX = 'vf_pvp_bus_';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const BUS_TTL_MS = 10000;
  const HUMAN_CAP = 16;
  const HUMAN_PER_TEAM = 8;
  const TEAM_SWITCH_COOLDOWN_SEC = 60;
  const TEAM_SWITCH_MAX = 3;
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

  function emptyRoster() {
    return { ally: [], enemy: [] };
  }

  function cloneRoster(roster) {
    return {
      ally: ((roster && roster.ally) || []).slice(),
      enemy: ((roster && roster.enemy) || []).slice(),
    };
  }

  function rosterCounts(roster) {
    return {
      ally: ((roster && roster.ally) || []).length,
      enemy: ((roster && roster.enemy) || []).length,
    };
  }

  function rosterTeamOf(roster, id) {
    if (!roster || id == null) return null;
    const sid = String(id);
    const allies = roster.ally || [];
    const enemies = roster.enemy || [];
    for (let i = 0; i < allies.length; i++) {
      if (String(allies[i]) === sid) return 'ally';
    }
    for (let i = 0; i < enemies.length; i++) {
      if (String(enemies[i]) === sid) return 'enemy';
    }
    return null;
  }

  function rosterAdd(roster, id, team) {
    const next = cloneRoster(roster);
    const sid = String(id);
    next.ally = next.ally.filter(function (item) {
      return String(item) !== sid;
    });
    next.enemy = next.enemy.filter(function (item) {
      return String(item) !== sid;
    });
    if (team === 'enemy') next.enemy.push(sid);
    else next.ally.push(sid);
    return next;
  }

  function rosterRemove(roster, id) {
    const sid = String(id);
    return {
      ally: ((roster && roster.ally) || []).filter(function (item) {
        return String(item) !== sid;
      }),
      enemy: ((roster && roster.enemy) || []).filter(function (item) {
        return String(item) !== sid;
      }),
    };
  }

  function pickJoinTeam(counts) {
    const hb = (counts && counts.ally) || 0;
    const hr = (counts && counts.enemy) || 0;
    if (hb + hr >= HUMAN_CAP) return null;
    if (hb < hr && hb < HUMAN_PER_TEAM) return 'ally';
    if (hr < hb && hr < HUMAN_PER_TEAM) return 'enemy';
    if (hb === hr) {
      if (hb >= HUMAN_PER_TEAM) return null;
      return Math.random() < 0.5 ? 'enemy' : 'ally';
    }
    if (hb < HUMAN_PER_TEAM) return 'ally';
    if (hr < HUMAN_PER_TEAM) return 'enemy';
    return null;
  }

  function openingSides(roster, hostId) {
    const hostTeam = rosterTeamOf(roster, hostId) || 'ally';
    return {
      hostTeam: hostTeam,
      guestTeam: hostTeam === 'enemy' ? 'ally' : 'enemy',
    };
  }

  function canSwitchTeam(from, to, counts) {
    if (!to || from === to) return false;
    const dest = to === 'enemy' ? (counts && counts.enemy) || 0 : (counts && counts.ally) || 0;
    return dest < HUMAN_PER_TEAM;
  }

  function isServerJoinable(server) {
    if (!server || !server.code) return false;
    const cap = Number(server.capacity);
    const players = Number(server.players);
    if (!isFinite(cap) || cap <= 0) return false;
    if (isFinite(players) && players >= cap) return false;
    const phase = String(server.phase || 'play');
    if (phase === 'closed') return false;
    return true;
  }

  function pickBestJoinableServer(servers) {
    const list = (servers || []).filter(isServerJoinable);
    if (!list.length) return null;
    list.sort(function (a, b) {
      const pingA = a.ping != null ? a.ping : 9999;
      const pingB = b.ping != null ? b.ping : 9999;
      if (pingA !== pingB) return pingA - pingB;
      return (b.players || 0) - (a.players || 0);
    });
    return list[0];
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
    _cancelledStartSeed: null,
    _pendingPrepCancel: null,
    _lastPrepCancelAt: 0,
    _lastNetCommandIds: null,
    spawnReadyLocal: false,
    spawnReadyRemote: false,
    _spawnGateAutoReady: false,
    _spawnGateAutoTimer: null,
    localLoadout: null,
    remoteLoadout: null,
    _lockedRemoteLoadout: null,
    remoteState: null,
    remoteAvatar: null,
    humanRoster: null,
    localTeam: 'ally',
    skipSpawnGate: true,
    _teamSwitchAt: 0,
    _teamSwitchCount: 0,
    _remoteAuthoritativeAlive: true,
    _remotePendingLifeId: null,
    _lastStateSend: 0,
    _serverInfo: null,
    _quickBusy: false,

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
      global.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (
          e.code === 'Escape' &&
          this.phase === 'spawnWait' &&
          this._spawnGateAutoReady
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.returnToLobbyFromPrep(true, this.matchSeed);
          return;
        }
        if (e.code !== 'KeyT') return;
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (this.requestTeamSwitch()) e.preventDefault();
      });
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
      if (msg.playerId) this._busClientId = this._normalizeNetId(msg.playerId);
      this.mode = role;
      this.skipSpawnGate = true;
      this.phase =
        this.phase === 'play' || this.phase === 'prep' || this.phase === 'spawnWait'
          ? this.phase
          : 'prep';
      this.roomCode = 'KUBEE';
      this._hideCover();
      if (this.els.lobbyOverlay) this.els.lobbyOverlay.classList.add('hidden');
      if (this.els.copyBtn) this.els.copyBtn.classList.add('hidden');

      this._startBus();
      if (role === 'host') {
        if (!this._rosterTeamOf(this._busClientId)) {
          this._ensureLocalRosterTeam();
        }
        if (!this._lobbyDone) this._launchInstantMatch();
        const live = Object.create(null);
        live[this._busClientId] = 1;
        for (let i = 0; i < players.length; i++) {
          const pid = this._normalizeNetId(players[i] && players[i].id);
          if (pid && pid !== this._busClientId) {
            live[pid] = 1;
            this._hostAssignPlayer(pid);
          }
        }
        const listed = (this.humanRoster && this.humanRoster.ally || []).concat(
          (this.humanRoster && this.humanRoster.enemy) || []
        );
        for (let i = 0; i < listed.length; i++) {
          if (!live[listed[i]]) this._hostRemovePlayer(listed[i]);
        }
      } else if (!this._lobbyDone) {
        this._busPublish();
        this._ingestBus();
        if (kubeePaired) this._send({ type: 'joinRequest', fromId: this._busClientId });
      }

      if (kubeePaired) {
        this.remotePresent = true;
        this.connected = true;
      }
      this._send({
        type: 'hello',
        role: this.mode,
        ready: this.localReady,
        wallTime: Date.now(),
      });
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
      this.skipSpawnGate = true;
      this.localReady = false;
      this.remoteReady = false;
      this.remotePresent = false;
      this.connected = false;
      this._pendingEnter = null;
      this._cancelledStartSeed = null;
      this._pendingPrepCancel = null;
      this._lastPrepCancelAt = 0;
      this._lastNetCommandIds = null;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;
      this.mode = this._electKubeeRoleFromBus();
      this._hideCover();
      if (this.els.lobbyOverlay) this.els.lobbyOverlay.classList.add('hidden');
      if (this.els.copyBtn) this.els.copyBtn.classList.add('hidden');
      this._startBus();
      if (this.mode === 'host') {
        if (!this._rosterTeamOf(this._busClientId)) {
          this._ensureLocalRosterTeam();
        }
        if (!this._lobbyDone) this._launchInstantMatch();
      } else if (!this._lobbyDone) {
        this._busPublish();
        this._ingestBus();
        this._send({ type: 'joinRequest', fromId: this._busClientId });
        this._toast('正在加入对局…');
      }
      if (global.VF_KUBEE && global.VF_KUBEE.lobby) {
        this._applyKubeeLobby(global.VF_KUBEE.lobby);
      } else if (global.VF_KUBEE) {
        global.VF_KUBEE.pingParent();
      }
    },

    /** Re-broadcast lobby presence (used when backing out of class select). */
    _sendLobbySync() {
      this._busPublish();
      this._send({
        type: 'hello',
        role: this.mode,
        ready: this.localReady,
        wallTime: Date.now(),
      });
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

    _netBusKey(role) {
      return (
        BUS_PREFIX +
        'net_' +
        (this.roomCode || '') +
        '_' +
        (role || this.mode || 'host')
      );
    },

    _netBusRemoteKey() {
      return this._netBusKey(this.mode === 'host' ? 'guest' : 'host');
    },

    _netCommandBusKey(role) {
      return (
        BUS_PREFIX +
        'netcmd_' +
        (this.roomCode || '') +
        '_' +
        (role || this.mode || 'host')
      );
    },

    _netCommandBusRemoteKey() {
      return this._netCommandBusKey(
        this.mode === 'host' ? 'guest' : 'host'
      );
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
          if (!suffix || /^(builds_|core_|dead_|dmg_|net_|netcmd_)/.test(suffix)) continue;
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
          const counts = rosterCounts(state.roster);
          const listedHumans = Math.max(
            counts.ally + counts.enemy,
            1 + (guestAlive ? 1 : 0)
          );
          out.push({
            code: String(state.code),
            name:
              (state.server && state.server.name) ||
              '社区对战服务器 [' + String(state.code) + ']',
            map: (state.server && state.server.map) || '荒盆',
            mode: (state.server && state.server.mode) || 'conquest',
            modeLabel: (state.server && state.server.modeLabel) || '征服',
            size: HUMAN_CAP,
            sizeLabel: '8 v 8',
            players: Math.min(HUMAN_CAP, listedHumans),
            capacity: HUMAN_CAP,
            ping: Math.max(1, Math.min(999, now - (state.host.ts || now))),
            official: false,
            password: false,
            phase: state.phase || 'play',
            createdAt: (state.server && state.server.createdAt) || state.ts || now,
          });
        }
      } catch (_) {}
      out.sort(function (a, b) {
        return b.createdAt - a.createdAt;
      });
      return out;
    },

    isServerJoinable(server) {
      return isServerJoinable(server);
    },

    listJoinableServers() {
      return this.listServers().filter(isServerJoinable);
    },

    joinRoomCode(code) {
      return this.joinRoom(code);
    },

    quickMatch() {
      if (this._quickBusy) return;
      this._quickBusy = true;
      const self = this;
      setTimeout(function () {
        self._quickBusy = false;
      }, 1400);
      if (this._isKubee()) {
        this._enterKubeeLobby();
        return;
      }
      let best = null;
      try {
        best = pickBestJoinableServer(this.listServers());
      } catch (_) {
        best = null;
      }
      if (best && best.code) {
        this._toast('正在加入 ' + (best.name || best.code));
        if (this.joinRoom(best.code, { silentFail: true }) !== false) return;
        this._toast('房间无法加入 · 正在创建匹配房间');
      } else {
        this._toast('未找到可加入房间 · 正在创建匹配房间');
      }
      this.createRoom({ quick: true });
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
        if (e.key === this._netBusRemoteKey()) this._pollNetBus();
        if (e.key === this._netCommandBusRemoteKey()) {
          this._pollNetCommandBus();
        }
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
        phase: this.phase || 'play',
        seed: this.matchSeed || prev.seed || null,
        roster: this.humanRoster ? cloneRoster(this.humanRoster) : prev.roster || emptyRoster(),
        server:
          prev.server ||
          this._serverInfo || {
            name: '社区对战服务器 [' + this.roomCode + ']',
            map: '荒盆',
            mode: 'conquest',
            modeLabel: '征服',
            createdAt: now,
          },
        host: prev.host || null,
        guest: prev.guest || null,
        start: prev.start || null,
        enter: prev.enter || null,
        prepCancel: prev.prepCancel || null,
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
        slot.weaponId = this.localLoadout.weaponId;
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
        slot.vehicleId = this._playState.vehicleId || null;
        slot.vehicleSeat =
          this._playState.vehicleSeat != null
            ? this._playState.vehicleSeat
            : null;
        slot.vehicleRole = this._playState.vehicleRole || null;
        slot.vehicleThrottle = this._playState.vehicleThrottle || 0;
        slot.vehicleSteer = this._playState.vehicleSteer || 0;
        slot.vehicleBrake = this._playState.vehicleBrake || 0;
        slot.vehicleBoost = !!this._playState.vehicleBoost;
        slot.vehicleSlow = !!this._playState.vehicleSlow;
        slot.vehicleTurretLocked = !!this._playState.vehicleTurretLocked;
        slot.vehicleAimYaw = this._playState.vehicleAimYaw || 0;
        slot.vehicleAimPitch = this._playState.vehicleAimPitch || 0;
        slot.vehicleWeaponIndex = this._playState.vehicleWeaponIndex || 0;
        slot.vehicleFire = !!this._playState.vehicleFire;
      }
      if (this.mode === 'host') next.host = slot;
      else next.guest = slot;

      if (this.mode === 'host' && this._pendingStart) next.start = this._pendingStart;
      if (this.mode === 'host' && this._pendingEnter) next.enter = this._pendingEnter;
      if (this._pendingPrepCancel) next.prepCancel = this._pendingPrepCancel;
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
        !this._lobbyDone &&
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
        if (
          this.phase !== 'play' &&
          (other.classId || other.weaponId || other.spawnId || other.team)
        ) {
          this.remoteLoadout = this._sanitizeRemoteLoadout({
            classId: other.classId || 'assault',
            weaponId: other.weaponId || 'ar',
            spawnId: other.spawnId || null,
            team: other.team || (this.mode === 'host' ? 'enemy' : 'ally'),
          });
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
            prone: !!other.prone,
            slide: !!other.slide,
            stealth: !!other.stealth,
            vehicleId: other.vehicleId || null,
            vehicleSeat:
              other.vehicleSeat != null ? other.vehicleSeat : null,
            vehicleRole: other.vehicleRole || null,
            vehicleThrottle: other.vehicleThrottle || 0,
            vehicleSteer: other.vehicleSteer || 0,
            vehicleBrake: other.vehicleBrake || 0,
            vehicleBoost: !!other.vehicleBoost,
            vehicleSlow: !!other.vehicleSlow,
            vehicleTurretLocked: !!other.vehicleTurretLocked,
            vehicleAimYaw: other.vehicleAimYaw || 0,
            vehicleAimPitch: other.vehicleAimPitch || 0,
            vehicleWeaponIndex: other.vehicleWeaponIndex || 0,
            vehicleFire: !!other.vehicleFire,
            classId: other.classId || (this.remoteLoadout && this.remoteLoadout.classId) || 'assault',
            team: other.team || (this.remoteLoadout && this.remoteLoadout.team),
          };
          if (other.alive === false) {
            this._remoteAuthoritativeAlive = false;
          }
          if (this._remoteAuthoritativeAlive === false) {
            this.remoteState.alive = false;
            this.remoteState.hp = 0;
          }
          if (
            this.mode === 'host' &&
            global.VF.NetSimulation &&
            global.VF.NetSimulation.observeRemotePlayerState
          ) {
            const actor =
              global.VF.NetSimulation.observeRemotePlayerState();
            this.remoteState.vehicleId = actor && actor.vehicleId;
            this.remoteState.vehicleSeat =
              actor && actor.vehicleSeat != null ? actor.vehicleSeat : null;
            this.remoteState.vehicleRole =
              (actor && actor.vehicleRole) || null;
          }
        }
      } else if (!peerUp) {
        if (this.phase === 'lobby') {
          this.remotePresent = false;
          this.remoteReady = false;
        }
        this.spawnReadyRemote = false;
        if (
          this.phase === 'spawnWait' &&
          this._spawnGateAutoReady &&
          !this.skipSpawnGate
        ) {
          this.remotePresent = false;
          this.returnToLobbyFromPrep(false, this.matchSeed);
          return;
        }
        if (
          this.mode === 'guest' &&
          this._lobbyDone &&
          !this._isKubee() &&
          (this.phase === 'play' || this.phase === 'prep')
        ) {
          this._toast('房主已离开 · 对局结束');
          this.leaveLobby();
          if (global.VF && global.VF.openFrontlineHub) {
            global.VF.openFrontlineHub();
          }
          return;
        }
      }

      const prepCancel = state.prepCancel;
      if (
        prepCancel &&
        prepCancel.fromId !== this._busClientId &&
        (prepCancel.t || 0) > this._lastPrepCancelAt
      ) {
        this._lastPrepCancelAt = prepCancel.t || now;
        if (
          this.phase === 'prep' &&
          !this.skipSpawnGate
        ) {
          this.returnToLobbyFromPrep(false, prepCancel.seed);
          return;
        }
        if (
          this.phase === 'spawnWait' &&
          !this.skipSpawnGate
        ) {
          this.returnToLobbyFromPrep(false, prepCancel.seed);
          return;
        }
      }

      this._syncRosterFromBus(state);
      if (this.mode === 'host') this._hostReconcilePresence(state, now);

      if (
        !this._lobbyDone &&
        this.mode === 'guest' &&
        this._rosterTeamOf(this._busClientId)
      ) {
        const seed =
          (state.start && state.start.seed) ||
          state.seed ||
          this.matchSeed;
        if (seed != null && seed !== this._cancelledStartSeed) {
          this.matchSeed = seed;
          this._beginMatchFromNet(state.start || { seed: seed });
          return;
        }
      }

      // Shared battlefield enter
      if (
        this._lobbyDone &&
        !this._battlefieldEntered &&
        !this.skipSpawnGate &&
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
      this._pollNetBus();
      this._pollNetCommandBus();

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
        this._setStatus('对手已加入 · 正在进入同一战场');
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

    createRoom(opts) {
      opts = opts || {};
      if (this._isKubee()) {
        this._enterKubeeLobby();
        return;
      }
      this.destroySession();
      this._destroyed = false;
      this.mode = 'host';
      this.skipSpawnGate = true;
      this.humanRoster = emptyRoster();
      this._ensureLocalRosterTeam();
      this.localReady = false;
      this.remoteReady = false;
      this.remotePresent = false;
      this.connected = false;
      this._battlefieldEntered = false;
      this._pendingEnter = null;
      this._cancelledStartSeed = null;
      this._pendingPrepCancel = null;
      this._lastPrepCancelAt = 0;
      this._lastNetCommandIds = null;
      this._teamSwitchAt = 0;
      this._teamSwitchCount = 0;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;
      this.roomCode = randomCode(6);
      this._serverInfo = {
        name: (opts.quick ? '匹配房间 [' : '社区对战服务器 [') + this.roomCode + ']',
        map: '荒盆',
        mode: 'conquest',
        modeLabel: opts.quick ? '快速匹配' : '征服',
        createdAt: Date.now(),
        source: opts.quick ? 'quick' : 'create',
      };
      this._hideCover();
      if (this.els.lobbyOverlay) this.els.lobbyOverlay.classList.add('hidden');
      this._startBus();
      this._toast(opts.quick ? '匹配房间已创建 · 正在进入战场' : '房间已创建 · 正在进入战场');
      this._launchInstantMatch();

      if (!this._ensurePeerJs()) return;

      const peerId = PEER_PREFIX + this.roomCode;
      try {
        this.peer = new Peer(peerId, PEER_OPTS);
      } catch (_) {
        return;
      }

      this.peer.on('error', (err) => {
        const msg = (err && err.type) || (err && err.message) || 'error';
        if (msg === 'unavailable-id') return;
      });
      this.peer.on('connection', (conn) => {
        if (this.conn && this.conn.open) {
          conn.close();
          return;
        }
        this._bindConn(conn);
      });
    },

    joinRoom(codeOverride, opts) {
      opts = opts || {};
      if (this._isKubee()) {
        this._enterKubeeLobby();
        return true;
      }
      const raw =
        codeOverride != null && String(codeOverride).length
          ? String(codeOverride)
          : (this.els.joinCode && this.els.joinCode.value) || '';
      const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 4) {
        if (this.els.joinErr) this.els.joinErr.textContent = '请输入有效房间码';
        return false;
      }
      if (this.els.joinCode) this.els.joinCode.value = code;
      if (this.els.joinErr) this.els.joinErr.textContent = '';

      this.destroySession();
      this._destroyed = false;
      this.mode = 'guest';
      this.skipSpawnGate = true;
      this.roomCode = code;
      this.humanRoster = emptyRoster();
      this.localReady = false;
      this.remoteReady = false;
      this.remotePresent = false;
      this.connected = false;
      this._battlefieldEntered = false;
      this._pendingStart = null;
      this._pendingEnter = null;
      this._cancelledStartSeed = null;
      this._pendingPrepCancel = null;
      this._lastPrepCancelAt = 0;
      this._lastNetCommandIds = null;
      this._teamSwitchAt = 0;
      this._teamSwitchCount = 0;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;

      if (this.els.joinOverlay) this.els.joinOverlay.classList.add('hidden');
      if (this.els.lobbyOverlay) this.els.lobbyOverlay.classList.add('hidden');
      this._hideCover();
      this._startBus();

      const bus = this._readBus();
      const hostAlive = !!(
        bus &&
        bus.host &&
        Date.now() - (bus.host.ts || 0) < BUS_TTL_MS
      );
      if (!hostAlive) {
        this._toast('房间不存在或已关闭');
        this.leaveLobby({ silent: !!opts.silentFail });
        return false;
      }
      const listed = {
        code: code,
        players: Math.max(
          rosterCounts(bus.roster).ally + rosterCounts(bus.roster).enemy,
          1
        ),
        capacity: HUMAN_CAP,
        phase: bus.phase || 'play',
      };
      if (!isServerJoinable(listed)) {
        this._toast('房间已满或不可加入');
        this.leaveLobby({ silent: !!opts.silentFail });
        return false;
      }
      this.remotePresent = true;
      this.connected = true;
      this.matchSeed =
        (bus.start && bus.start.seed) || bus.seed || this.matchSeed;
      this._syncRosterFromBus(bus);
      this._busPublish();
      this._send({ type: 'joinRequest', fromId: this._busClientId });
      if (this._rosterTeamOf(this._busClientId)) {
        this._beginMatchFromNet(bus.start || { seed: this.matchSeed });
      } else {
        this._toast('正在加入对局…');
      }

      if (this._ensurePeerJs()) {
        try {
          this.peer = new Peer(PEER_OPTS);
        } catch (_) {
          return true;
        }
        this.peer.on('open', () => {
          try {
            this._bindConn(this.peer.connect(PEER_PREFIX + code, CONN_OPTS));
          } catch (_) {}
        });
      }
      return true;
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
        this._send({
          type: 'hello',
          role: this.mode,
          ready: this.localReady,
          wallTime: Date.now(),
        });
        if (this.mode === 'guest') {
          this._send({ type: 'joinRequest' });
        }
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
          if (typeof data.wallTime === 'number') {
            this._remoteClockOffset = Date.now() - data.wallTime;
          }
          if (typeof data.ready === 'boolean') this.remoteReady = data.ready;
          if (this.mode === 'host') {
            this._hostAssignPlayer(data.fromId, { sync: true });
          }
          this._updateStatusFromFlags();
          this._refreshLobby();
          break;
        case 'joinRequest':
          if (this.mode === 'host') this._hostAssignPlayer(data.fromId, { sync: true });
          break;
        case 'roster':
          this._applyRosterPayload(data);
          break;
        case 'teamSwitch':
          if (data.playerId && data.team) {
            if (this.mode === 'host') this._hostApplyTeamSwitch(data.playerId, data.team);
            else this._applyRosterPayload(data);
          }
          break;
        case 'teamSwitchRequest':
          if (this.mode === 'host') {
            this._hostApplyTeamSwitch(data.fromId || data.playerId, data.team);
          }
          break;
        case 'ready':
          this.remoteReady = !!data.ready;
          this._updateStatusFromFlags();
          this._refreshLobby();
          break;
        case 'spawnReady':
          if (this.phase !== 'prep' && this.phase !== 'spawnWait') break;
          if (data.loadout) {
            const sanitized = this._sanitizeRemoteLoadout(data.loadout);
            if (!sanitized && data.ready) {
              this.spawnReadyRemote = false;
              break;
            }
            if (sanitized) this.remoteLoadout = sanitized;
          }
          this.spawnReadyRemote = !!data.ready;
          this._refreshMatchReadyUI();
          if (
            this.mode === 'host' &&
            this.spawnReadyLocal &&
            this.spawnReadyRemote
          ) {
            this._hostPublishEnter();
          }
          break;
        case 'prepCancel':
          if (
            (this.phase === 'prep' || this.phase === 'spawnWait') &&
            !this.skipSpawnGate
          ) {
            this.returnToLobbyFromPrep(false, data.seed);
          }
          break;
        case 'enter':
          this._enterBattlefield(data);
          break;
        case 'state':
          if (data.alive === false) {
            this._remoteAuthoritativeAlive = false;
          }
          if (
            this._remoteAuthoritativeAlive === false &&
            data.alive !== false
          ) {
            data.alive = false;
            data.hp = 0;
          }
          this.remoteState = data;
          if (
            this.mode === 'host' &&
            global.VF.NetSimulation &&
            global.VF.NetSimulation.observeRemotePlayerState
          ) {
            const actor =
              global.VF.NetSimulation.observeRemotePlayerState();
            data.vehicleId = actor && actor.vehicleId;
            data.vehicleSeat =
              actor && actor.vehicleSeat != null ? actor.vehicleSeat : null;
            data.vehicleRole = (actor && actor.vehicleRole) || null;
          }
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
          this._remoteAuthoritativeAlive = false;
          break;
        case 'playerCasualty':
          if (
            this.phase === 'play' &&
            data.seed === this.matchSeed &&
            data.lifeId &&
            this._remoteAuthoritativeAlive === false
          ) {
            this._remotePendingLifeId = data.lifeId;
          }
          break;
        case 'playerRespawn':
          if (
            this.phase === 'play' &&
            this._remoteAuthoritativeAlive === false &&
            data.seed === this.matchSeed &&
            data.lifeId &&
            data.lifeId === this._remotePendingLifeId
          ) {
            const team =
              (this._lockedRemoteLoadout &&
                this._lockedRemoteLoadout.team) ||
              (this.mode === 'host' ? 'enemy' : 'ally');
            const C = global.VF && global.VF.Conquest;
            const points =
              C && C.listDeployPoints
                ? C.listDeployPoints(team)
                : [];
            const point = points.find(function (entry) {
              return (
                entry.id === data.spawnId &&
                entry.team === team &&
                entry.available !== false
              );
            });
            if (!point) break;
            const classes =
              (global.VF.Soldier && global.VF.Soldier.CLASSES) || [];
            const nextClass = classes.some(function (entry) {
              return entry.id === data.classId;
            })
              ? data.classId
              : this._lockedRemoteLoadout &&
                  this._lockedRemoteLoadout.classId;
            if (this._lockedRemoteLoadout && nextClass) {
              this._lockedRemoteLoadout.classId = nextClass;
              if (
                global.VF.WEAPONS &&
                global.VF.WEAPONS[data.weaponId]
              ) {
                this._lockedRemoteLoadout.weaponId = data.weaponId;
              }
            }
            this._remoteAuthoritativeAlive = true;
            this._lastRemoteAlive = true;
            this._remotePendingLifeId = null;
            if (
              global.VF.NetSimulation &&
              global.VF.NetSimulation.onRemoteRespawn
            ) {
              global.VF.NetSimulation.onRemoteRespawn(point);
            }
            if (this.remoteState) {
              this.remoteState.alive = true;
              this.remoteState.hp = 100;
              this.remoteState.x = point.x;
              this.remoteState.y = point.y;
              this.remoteState.z = point.z;
            }
          }
          break;
        case 'conquest-snapshot':
        case 'conquest-snapshot-request':
        case 'conquest-command':
          if (global.VF.NetSimulation && global.VF.NetSimulation.receive) {
            data._receivedAt = performance.now();
            global.VF.NetSimulation.receive(data);
          }
          break;
        case 'start':
          if (!this._lobbyDone && data.seed !== this._cancelledStartSeed) {
            this.matchSeed = data.seed || Date.now();
            if (data.roster) this._applyRosterPayload(data);
            this._beginMatchFromNet(data);
          }
          break;
        case 'joinDenied':
          this._toast(
            data.reason === 'full' ? '房间已满（最多 8v8）' : '无法加入房间'
          );
          this.leaveLobby();
          if (global.VF && global.VF.openFrontlineHub) {
            global.VF.openFrontlineHub();
          }
          break;
        case 'leave':
          this.remotePresent = false;
          this.remoteReady = false;
          this.spawnReadyRemote = false;
          if (this.mode === 'host' && data.fromId) {
            this._hostRemovePlayer(data.fromId);
          }
          if (
            this.phase === 'spawnWait' &&
            this._spawnGateAutoReady &&
            !this.skipSpawnGate
          ) {
            this.returnToLobbyFromPrep(false, this.matchSeed);
            break;
          }
          if (this.phase === 'play' || this.skipSpawnGate) {
            this._toast('一名玩家已离开 · AI 已补位');
            break;
          }
          this._setStatus('对手已离开房间');
          this._refreshLobby();
          this._refreshMatchReadyUI();
          break;
        default:
          break;
      }
    },

    _send(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (!obj.fromId) obj.fromId = this._busClientId;
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
      if (
        this.roomCode &&
        obj &&
        (obj.type === 'conquest-snapshot' ||
          obj.type === 'conquest-snapshot-request' ||
          obj.type === 'conquest-command' ||
          obj.type === 'playerCasualty' ||
          obj.type === 'playerRespawn')
      ) {
        try {
          const packet = {
            id:
              this._busClientId +
              ':' +
              obj.type +
              ':' +
              (obj.seq || 0) +
              ':' +
              Date.now(),
            fromId: this._busClientId,
            sentAt: Date.now(),
            message: obj,
          };
          if (
            obj.type === 'conquest-command' ||
            obj.type === 'playerCasualty' ||
            obj.type === 'playerRespawn'
          ) {
            const key = this._netCommandBusKey(this.mode);
            let queue = [];
            try {
              queue = JSON.parse(localStorage.getItem(key) || '[]');
            } catch (_) {}
            if (!Array.isArray(queue)) queue = [];
            queue.push(packet);
            if (queue.length > 32) queue = queue.slice(-32);
            localStorage.setItem(key, JSON.stringify(queue));
          } else {
            localStorage.setItem(
              this._netBusKey(this.mode),
              JSON.stringify(packet)
            );
          }
        } catch (_) {}
      }
    },

    _pollNetBus() {
      if (!this.roomCode) return;
      try {
        const raw = localStorage.getItem(this._netBusRemoteKey());
        if (!raw) return;
        const packet = JSON.parse(raw);
        if (
          !packet ||
          !packet.id ||
          packet.id === this._lastNetBusId ||
          packet.fromId === this._busClientId ||
          (packet.sentAt && Date.now() - packet.sentAt > 5000) ||
          !packet.message
        ) {
          return;
        }
        this._lastNetBusId = packet.id;
        this._onData(packet.message);
      } catch (_) {}
    },

    _pollNetCommandBus() {
      if (!this.roomCode) return;
      try {
        const raw = localStorage.getItem(this._netCommandBusRemoteKey());
        if (!raw) return;
        const queue = JSON.parse(raw);
        if (!Array.isArray(queue)) return;
        if (!this._lastNetCommandIds) {
          this._lastNetCommandIds = Object.create(null);
        }
        const cutoff = Date.now() - 5000;
        for (let i = 0; i < queue.length; i++) {
          const packet = queue[i];
          if (
            !packet ||
            !packet.id ||
            this._lastNetCommandIds[packet.id] ||
            packet.fromId === this._busClientId ||
            (packet.sentAt || 0) < cutoff ||
            !packet.message
          ) {
            continue;
          }
          this._lastNetCommandIds[packet.id] = 1;
          this._onData(packet.message);
        }
        const ids = Object.keys(this._lastNetCommandIds);
        if (ids.length > 96) {
          const keep = Object.create(null);
          for (let i = ids.length - 64; i < ids.length; i++) {
            keep[ids[i]] = 1;
          }
          this._lastNetCommandIds = keep;
        }
      } catch (_) {}
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
      this._cancelledStartSeed = null;
      this._pendingPrepCancel = null;
      const bus = this._readBus();
      if (bus && bus.prepCancel) {
        bus.prepCancel = null;
        this._writeBus(bus);
      }
      this.matchSeed = seed;
      const sides = this._startSides();
      const payload = {
        type: 'start',
        seed: seed,
        hostTeam: sides.hostTeam,
        guestTeam: sides.guestTeam,
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
      this.skipSpawnGate = true;
      this.phase = 'prep';
      this.localReady = false;
      this.remoteReady = false;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;
      if (this.els.lobbyOverlay) this.els.lobbyOverlay.classList.add('hidden');
      const isHost = this.mode === 'host';
      const team =
        this._rosterTeamOf(this._busClientId) ||
        (isHost
          ? (data && data.hostTeam) || 'ally'
          : (data && data.guestTeam) || 'enemy');
      this.localTeam = team;
      if (typeof this._onMatchStart === 'function') {
        this._onMatchStart({
          mode: 'pvp',
          role: this.mode,
          roomCode: this.roomCode,
          seed: (data && data.seed) || this.matchSeed,
          team: team,
          isHost: isHost,
        });
      }
      this._busPublish();
    },

    /** Wait until both clients have finished the pre-match presentation. */
    openSpawnGate(loadout, onEnter, onBack, opts) {
      opts = opts || {};
      const autoReady = !!opts.autoReady;
      if (this._spawnGateAutoTimer) clearTimeout(this._spawnGateAutoTimer);
      this._spawnGateAutoTimer = null;
      this._spawnGateAutoReady = autoReady;
      this.phase = 'spawnWait';
      this.localLoadout = loadout || null;
      this.spawnReadyLocal = autoReady;
      this._onEnterBattlefield = onEnter;
      this._onSpawnGateBack = onBack;
      this._battlefieldEntered = false;
      this._pendingEnter = null;
      this._busPublish();
      this._send({
        type: 'spawnReady',
        ready: this.spawnReadyLocal,
        loadout: this.localLoadout,
      });
      if (this.els.matchReadyOverlay) {
        this.els.matchReadyOverlay.classList.toggle('hidden', autoReady);
      }
      if (autoReady) {
        this._stopMatchPreviews();
      } else {
        this._startMatchPreviews();
      }
      this._refreshMatchReadyUI();
      if (
        autoReady &&
        this.mode === 'host' &&
        this.spawnReadyRemote
      ) {
        this._hostPublishEnter();
      }
      if (autoReady && !this._battlefieldEntered) {
        if (global.VF && global.VF.UI && global.VF.UI.toast) {
          global.VF.UI.toast('等待对手进入战场 · Esc 返回联机大厅');
        }
        this._spawnGateAutoTimer = setTimeout(() => {
          if (
            this.phase === 'spawnWait' &&
            !this._battlefieldEntered &&
            this._spawnGateAutoReady
          ) {
            if (global.VF && global.VF.UI && global.VF.UI.toast) {
              global.VF.UI.toast('对手同步超时 · 已返回联机大厅');
            }
            this.returnToLobbyFromPrep(true, this.matchSeed);
          }
        }, 12000);
      }
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
      if (this._spawnGateAutoTimer) clearTimeout(this._spawnGateAutoTimer);
      this._spawnGateAutoTimer = null;
      this._spawnGateAutoReady = false;
      this.spawnReadyLocal = false;
      this.phase = 'prep';
      this._busPublish();
      this._send({
        type: 'spawnReady',
        ready: false,
        loadout: this.localLoadout,
      });
      this._stopMatchPreviews();
      if (this.els.matchReadyOverlay) {
        this.els.matchReadyOverlay.classList.add('hidden');
      }
      if (typeof this._onSpawnGateBack === 'function') this._onSpawnGateBack();
    },

    returnToLobbyFromPrep(notifyPeer, cancelledSeed) {
      if (this._spawnGateAutoTimer) clearTimeout(this._spawnGateAutoTimer);
      this._spawnGateAutoTimer = null;
      this._spawnGateAutoReady = false;
      const seed =
        cancelledSeed != null
          ? cancelledSeed
          : this.matchSeed != null
            ? this.matchSeed
            : this._pendingStart && this._pendingStart.seed;
      this._cancelledStartSeed = seed != null ? seed : null;
      if (notifyPeer !== false) {
        this._pendingPrepCancel = {
          seed: this._cancelledStartSeed,
          t: Date.now(),
          fromId: this._busClientId,
        };
        this._lastPrepCancelAt = this._pendingPrepCancel.t;
        this._send({ type: 'prepCancel', seed: this._cancelledStartSeed });
      } else {
        this._pendingPrepCancel = null;
      }
      this.phase = 'lobby';
      this._lobbyDone = false;
      this._battlefieldEntered = false;
      this._pendingStart = null;
      this._pendingEnter = null;
      this.localReady = false;
      this.remoteReady = false;
      this.spawnReadyLocal = false;
      this.spawnReadyRemote = false;
      this.localLoadout = null;
      this.remoteLoadout = null;
      this._lockedRemoteLoadout = null;
      this._stopMatchPreviews();
      if (this.els.matchReadyOverlay) {
        this.els.matchReadyOverlay.classList.add('hidden');
      }
      const bus = this._readBus();
      if (bus) {
        bus.phase = 'lobby';
        bus.start = null;
        bus.enter = null;
        this._writeBus(bus);
      }
      if (global.VF && global.VF.UI && global.VF.UI.closeClassSelect) {
        global.VF.UI.closeClassSelect();
      }
      if (global.VF && global.VF.UI && global.VF.UI.closeSquadIntro) {
        global.VF.UI.closeSquadIntro();
      }
      if (global.VF && global.VF.UI && global.VF.UI.closeLoadoutCustomize) {
        global.VF.UI.closeLoadoutCustomize();
      }
      if (global.VF && global.VF.game) {
        if (global.VF.clearPreMatchMapView) global.VF.clearPreMatchMapView();
        else global.VF.game._preMatchView = null;
      }
      this._openLobbyUI();
      this._setStatus('已返回大厅 · 双方重新准备后开始');
      this._busPublish();
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
      if (this.phase !== 'spawnWait') return;
      if (
        data &&
        data.seed != null &&
        this.matchSeed != null &&
        data.seed !== this.matchSeed
      ) {
        return;
      }
      if (this._spawnGateAutoTimer) clearTimeout(this._spawnGateAutoTimer);
      this._spawnGateAutoTimer = null;
      this._spawnGateAutoReady = false;
      this._battlefieldEntered = true;
      this.phase = 'play';
      this._remoteAuthoritativeAlive = true;
      this._remotePendingLifeId = null;
      this._lockedRemoteLoadout = this.remoteLoadout
        ? Object.assign({}, this.remoteLoadout)
        : null;
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

    _sanitizeRemoteLoadout(loadout) {
      if (!loadout || typeof loadout !== 'object') return null;
      const expectedTeam = this._expectedRemoteTeam(loadout && loadout.team);
      const classes =
        (global.VF &&
          global.VF.Soldier &&
          global.VF.Soldier.CLASSES) ||
        [];
      const classId = classes.some(function (entry) {
        return entry.id === loadout.classId;
      })
        ? loadout.classId
        : 'assault';
      const weaponId =
        global.VF &&
        global.VF.WEAPONS &&
        global.VF.WEAPONS[loadout.weaponId]
          ? loadout.weaponId
          : 'ar';
      let spawnId = loadout.spawnId || null;
      const world = global.VF && global.VF.game && global.VF.game.world;
      const spawnPoints =
        world && world._spawnPoints && world._spawnPoints.all
          ? world._spawnPoints.all
          : [];
      if (spawnPoints.length && !spawnId) return null;
      if (spawnId && spawnPoints.length) {
        const valid = spawnPoints.some(function (point) {
          return point.id === spawnId && point.team === expectedTeam;
        });
        if (!valid) return null;
      }
      return {
        classId: classId,
        weaponId: weaponId,
        spawnId: spawnId,
        team: expectedTeam,
      };
    },

    _weaponLabel(weaponId) {
      const defs = global.VF && global.VF.WEAPONS;
      const def = defs && defs[weaponId || 'ar'];
      return def ? def.nameZh || def.name || weaponId : weaponId || 'AKM';
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
          ? this._teamLabel(ll.team) +
            ' · ' +
            this._classLabel(ll.classId) +
            ' · ' +
            this._weaponLabel(ll.weaponId)
          : '—';
      }

      const rl = this.remoteLoadout;
      if (this.els.matchFoeClass) {
        this.els.matchFoeClass.textContent = rl
          ? this._teamLabel(rl.team) +
            ' · ' +
            this._classLabel(rl.classId) +
            ' · ' +
            this._weaponLabel(rl.weaponId)
          : '等待中…';
      }
      if (this.els.matchFoeInfo) {
        this.els.matchFoeInfo.textContent = rl
          ? '对手：' +
            this._teamLabel(rl.team) +
            ' · ' +
            this._classLabel(rl.classId) +
            ' · ' +
            this._weaponLabel(rl.weaponId)
          : '对手兵种同步中…';
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
            '兵种已确认 · 双方都点「准备进入」后进入同一战场';
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
          vehicleId: state.vehicleId || null,
          vehicleSeat:
            state.vehicleSeat != null ? state.vehicleSeat : null,
          vehicleRole: state.vehicleRole || null,
          vehicleThrottle: state.vehicleThrottle || 0,
          vehicleSteer: state.vehicleSteer || 0,
          vehicleBrake: state.vehicleBrake || 0,
          vehicleBoost: !!state.vehicleBoost,
          vehicleSlow: !!state.vehicleSlow,
          vehicleTurretLocked: !!state.vehicleTurretLocked,
          vehicleAimYaw: state.vehicleAimYaw || 0,
          vehicleAimPitch: state.vehicleAimPitch || 0,
          vehicleWeaponIndex: state.vehicleWeaponIndex || 0,
          vehicleFire: !!state.vehicleFire,
          weaponFireSeq: state.weaponFireSeq || 0,
          weaponId: state.weaponId || null,
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
          prone: false,
          slide: false,
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

    reportLocalRespawn() {
      if (this._matchEnded || this.phase !== 'play') return;
      const game = global.VF && global.VF.game;
      const team =
        (game && game.player && game.player.team) ||
        (game && game.world && game.world._playerTeam) ||
        (this.mode === 'host' ? 'ally' : 'enemy');
      const selected =
        (game && game._lastDeploymentSelection) ||
        (game &&
          game.world &&
          game.world.getSelectedSpawn &&
          game.world.getSelectedSpawn());
      if (game && game._lastRespawnLifeId) {
        this._send({
          type: 'playerCasualty',
          lifeId: game._lastRespawnLifeId,
          seed: this.matchSeed,
        });
      }
      this._send({
        type: 'playerRespawn',
        team: team,
        spawnId: selected && selected.id,
        vehicleId: game && game.player && game.player.vehicleId,
        classId:
          game && game.player
            ? game.player.classId
            : this.localLoadout && this.localLoadout.classId,
        weaponId:
          game && game.weapons
            ? game.weapons.current
            : this.localLoadout && this.localLoadout.weaponId,
        vehicleSeat:
          game && game.player && game.player.vehicleSeat != null
            ? game.player.vehicleSeat
            : null,
        lifeId: game && game._lastRespawnLifeId,
        seed: this.matchSeed,
      });
      if (game) {
        game._lastDeploymentSelection = null;
        game._lastRespawnLifeId = null;
      }
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
      m.visible = st.alive !== false && !st.stealth && !st.vehicleId;
      if (
        av._weaponFireSeq != null &&
        st.weaponFireSeq != null &&
        st.weaponFireSeq !== av._weaponFireSeq &&
        st.alive !== false &&
        !st.vehicleId &&
        global.VF.Audio
      ) {
        global.VF.Audio.play('weapon.' + (st.weaponId || 'ak74') + '.fire', {
          position: m.position,
          maxDistance: 280,
          priority: 7,
        });
      }
      if (st.weaponFireSeq != null) av._weaponFireSeq = st.weaponFireSeq;
      if (global.VF.Soldier) {
        if (global.VF.Soldier.setCrouchPose) {
          global.VF.Soldier.setCrouchPose(m, !!st.crouch, {
            prone: !!st.prone,
            slide: !!st.slide,
          });
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
      if (!st || st.x == null || st.alive === false || st.vehicleId) return null;
      const av = this.remoteAvatar;
      const px = av && av.mesh ? av.mesh.position.x : st.x;
      const py = av && av.mesh ? av.mesh.position.y : st.y;
      const pz = av && av.mesh ? av.mesh.position.z : st.z;
      const HB = global.VF && global.VF.Hitboxes;
      if (HB && HB.raycast) {
        const entity = {
          position: { x: px, y: py, z: pz },
          crouch: !!st.crouch,
          crouching: !!st.crouch,
          prone: !!st.prone,
          vehicleId: st.vehicleId || null,
          alive: st.alive !== false,
        };
        const hit = HB.raycast(entity, origin, dir, range);
        if (!hit) return null;
        return { point: hit.point, dist: hit.dist, part: hit.part };
      }
      const crouchT = st.crouch ? 1 : 0;
      const centerY = py + (1.15 - crouchT * 0.45);
      const hitR = 1.15 - crouchT * 0.3;
      const center = new THREE.Vector3(px, centerY, pz);
      const to = center.clone().sub(origin);
      const proj = to.dot(dir);
      if (proj < 0 || proj > range) return null;
      const closest = origin.clone().addScaledVector(dir, proj);
      if (closest.distanceTo(center) > hitR) return null;
      return { point: closest, dist: proj, part: 'torso' };
    },

    /** Deal damage to the remote player (networked). */
    dealDamageToRemote(dmg) {
      if (this.phase !== 'play' || !(dmg > 0)) return { killed: false };
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
      let killed = false;
      if (this.remoteState) {
        this.remoteState.hp = Math.max(
          0,
          (this.remoteState.hp != null ? this.remoteState.hp : 100) - dmg
        );
        if (this.remoteState.hp <= 0) {
          this.remoteState.alive = false;
          this._remoteAuthoritativeAlive = false;
          killed = true;
        }
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
      return { killed: !!killed };
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
      const source = {
        entityId: 'remote-player',
        team:
          (this._lockedRemoteLoadout && this._lockedRemoteLoadout.team) ||
          (this.mode === 'host' ? 'enemy' : 'ally'),
        weaponId:
          (this._lockedRemoteLoadout && this._lockedRemoteLoadout.weaponId) ||
          null,
      };
      if (game.player.takeDamage) game.player.takeDamage(dmg, from, source);
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

    leaveLobby(opts) {
      opts = opts || {};
      this._send({ type: 'leave' });
      try {
        const state = this._readBus();
        if (state && this.mode) {
        if (this.mode === 'host') {
          state.host = null;
          state.roster = emptyRoster();
          state.phase = 'closed';
        } else {
          state.guest = null;
        }
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
      if (!opts.silent) this._showCover();
    },

    destroySession() {
      this._destroyed = true;
      this._stopBus();
      if (this._spawnGateAutoTimer) clearTimeout(this._spawnGateAutoTimer);
      this._spawnGateAutoTimer = null;
      this._spawnGateAutoReady = false;
      this._pendingStart = null;
      this._pendingEnter = null;
      this._cancelledStartSeed = null;
      this._pendingPrepCancel = null;
      this._lastPrepCancelAt = 0;
      this._lastNetCommandIds = null;
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
      this._lockedRemoteLoadout = null;
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
      this.humanRoster = emptyRoster();
      this.localTeam = 'ally';
      this.skipSpawnGate = true;
      this._teamSwitchAt = 0;
      this._teamSwitchCount = 0;
      this._lastGuestId = null;
      this._serverInfo = null;
      this._destroyed = false;
    },

    _normalizeNetId(id) {
      if (id == null || id === '') return null;
      const s = String(id);
      if (this._isKubee() && s.indexOf('k_') !== 0) return 'k_' + s;
      return s;
    },

    _rosterTeamOf(id) {
      return rosterTeamOf(this.humanRoster, id);
    },

    _ensureLocalRosterTeam() {
      const existing = this._rosterTeamOf(this._busClientId);
      if (existing === 'ally' || existing === 'enemy') {
        this.localTeam = existing;
        return existing;
      }
      const team = pickJoinTeam(this.getHumanCounts()) || (Math.random() < 0.5 ? 'enemy' : 'ally');
      this.localTeam = team;
      this.humanRoster = rosterAdd(this.humanRoster || emptyRoster(), this._busClientId, team);
      return team;
    },

    _startSides() {
      return openingSides(this.humanRoster, this._busClientId);
    },

    getHumanCounts() {
      return rosterCounts(this.humanRoster || emptyRoster());
    },

    _syncRosterFromBus(bus) {
      if (!bus) return;
      if (bus.roster) this.humanRoster = cloneRoster(bus.roster);
      if (bus.seed && !this.matchSeed) this.matchSeed = bus.seed;
      const team = this._rosterTeamOf(this._busClientId);
      if (team) this.localTeam = team;
    },

    _expectedRemoteTeam(hint) {
      const mine = this._busClientId;
      const roster = this.humanRoster || emptyRoster();
      const ids = (roster.ally || []).concat(roster.enemy || []);
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i]) !== String(mine)) {
          return rosterTeamOf(roster, ids[i]) || hint || 'enemy';
        }
      }
      if (hint === 'ally' || hint === 'enemy') return hint;
      return this.mode === 'host' ? 'enemy' : 'ally';
    },

    _launchInstantMatch() {
      if (this._lobbyDone) return;
      if (this.mode !== 'host') return;
      const seed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
      this.matchSeed = seed;
      this.skipSpawnGate = true;
      this._cancelledStartSeed = null;
      if (!this._rosterTeamOf(this._busClientId)) {
        this._ensureLocalRosterTeam();
      }
      const sides = this._startSides();
      const payload = {
        type: 'start',
        seed: seed,
        hostTeam: sides.hostTeam,
        guestTeam: sides.guestTeam,
        fromId: this._busClientId,
        roster: cloneRoster(this.humanRoster),
      };
      this._pendingStart = payload;
      this._busPublish();
      this._send(payload);
      this._beginMatchFromNet(payload);
    },

    _broadcastRoster() {
      const payload = {
        type: 'roster',
        roster: cloneRoster(this.humanRoster || emptyRoster()),
        seed: this.matchSeed,
        fromId: this._busClientId,
      };
      this._busPublish();
      this._send(payload);
    },

    _applyRosterPayload(data) {
      if (!data) return;
      if (data.roster) this.humanRoster = cloneRoster(data.roster);
      if (data.seed) this.matchSeed = data.seed;
      const team = this._rosterTeamOf(this._busClientId);
      if (team) {
        const game = global.VF && global.VF.game;
        const switched = team !== this.localTeam && this._lobbyDone;
        this.localTeam = team;
        if (switched && game && game.running) this._applyLocalTeamChange(team);
      }
      if (!this._lobbyDone && team) {
        this._beginMatchFromNet({ seed: this.matchSeed, roster: this.humanRoster });
      }
      this._onRosterChanged();
    },

    _hostReconcilePresence(state, now) {
      if (this.mode !== 'host' || this._isKubee()) return;
      const guest = state && state.guest;
      const guestAlive = !!(guest && now - (guest.ts || 0) < BUS_TTL_MS && guest.id);
      if (guestAlive) {
        this._lastGuestId = guest.id;
        this._hostAssignPlayer(guest.id);
      } else if (this._lastGuestId) {
        this._hostRemovePlayer(this._lastGuestId);
        this._lastGuestId = null;
      }
    },

    _hostAssignPlayer(id, opts) {
      if (this.mode !== 'host') return;
      const pid = this._normalizeNetId(id);
      if (!pid || pid === this._busClientId) return;
      if (this._rosterTeamOf(pid)) {
        if (opts && opts.sync) {
          this._send({
            type: 'roster',
            roster: cloneRoster(this.humanRoster || emptyRoster()),
            seed: this.matchSeed,
          });
          this._send({
            type: 'start',
            seed: this.matchSeed,
            roster: cloneRoster(this.humanRoster || emptyRoster()),
            hostTeam: this._startSides().hostTeam,
            guestTeam: this._startSides().guestTeam,
          });
        }
        return;
      }
      const team = pickJoinTeam(this.getHumanCounts());
      if (!team) {
        this._send({ type: 'joinDenied', reason: 'full' });
        return;
      }
      this.humanRoster = rosterAdd(this.humanRoster || emptyRoster(), pid, team);
      if (!this._pendingStart) {
        this._pendingStart = {
          type: 'start',
          seed: this.matchSeed,
          roster: cloneRoster(this.humanRoster),
          fromId: this._busClientId,
        };
      } else {
        this._pendingStart.roster = cloneRoster(this.humanRoster);
      }
      this._broadcastRoster();
      const sides = this._startSides();
      this._send({
        type: 'start',
        seed: this.matchSeed,
        roster: cloneRoster(this.humanRoster),
        hostTeam: sides.hostTeam,
        guestTeam: sides.guestTeam,
      });
      this._onRosterChanged();
    },

    _hostRemovePlayer(id) {
      if (this.mode !== 'host') return;
      const pid = this._normalizeNetId(id);
      if (!pid || pid === this._busClientId) return;
      if (!this._rosterTeamOf(pid)) return;
      this.humanRoster = rosterRemove(this.humanRoster, pid);
      this._broadcastRoster();
      this._onRosterChanged();
    },

    _hostApplyTeamSwitch(id, team) {
      if (this.mode !== 'host') return;
      const pid = this._normalizeNetId(id);
      if (!pid || (team !== 'ally' && team !== 'enemy')) return;
      const from = this._rosterTeamOf(pid);
      if (!from || from === team) return;
      if (!canSwitchTeam(from, team, this.getHumanCounts())) return;
      this.humanRoster = rosterAdd(this.humanRoster, pid, team);
      this._broadcastRoster();
      this._send({
        type: 'teamSwitch',
        playerId: pid,
        team: team,
        roster: cloneRoster(this.humanRoster),
      });
      if (pid === this._busClientId) this._applyLocalTeamChange(team);
      this._onRosterChanged();
    },

    requestTeamSwitch() {
      if (!this.roomCode || !this._lobbyDone) return false;
      const game = global.VF && global.VF.game;
      if (!game || game.mode !== 'pvp' || !game.running) return false;
      const from = this.localTeam === 'enemy' ? 'enemy' : 'ally';
      const to = from === 'ally' ? 'enemy' : 'ally';
      const counts = this.getHumanCounts();
      if (!canSwitchTeam(from, to, counts)) {
        this._toast('目标阵营真人已满 8 人');
        return false;
      }
      if (this._teamSwitchCount >= TEAM_SWITCH_MAX) {
        this._toast('本局换边次数已用完');
        return false;
      }
      const now = Date.now();
      const wait = TEAM_SWITCH_COOLDOWN_SEC * 1000 - (now - (this._teamSwitchAt || 0));
      if (this._teamSwitchAt && wait > 0) {
        this._toast('换边冷却中 · ' + Math.ceil(wait / 1000) + 's');
        return false;
      }
      this._teamSwitchAt = now;
      this._teamSwitchCount += 1;
      if (this.mode === 'host') {
        this._hostApplyTeamSwitch(this._busClientId, to);
      } else {
        this._send({ type: 'teamSwitchRequest', fromId: this._busClientId, team: to });
        this._toast('正在换边…');
      }
      return true;
    },

    _pickHqSpawn(team) {
      const world = global.VF && global.VF.game && global.VF.game.world;
      if (!world) return null;
      const points = (world._spawnPoints && world._spawnPoints[team]) || [];
      for (let i = 0; i < points.length; i++) {
        if (points[i].fixed || points[i].kind === 'hq') return points[i];
      }
      return points[0] || null;
    },

    _applyLocalTeamChange(team) {
      if (team !== 'ally' && team !== 'enemy') return;
      this.localTeam = team;
      const game = global.VF && global.VF.game;
      if (!game) return;
      if (game.pvp) game.pvp.team = team;
      if (game.world && game.world.setPlayerTeam) game.world.setPlayerTeam(team);
      if (game.player) game.player.team = team;
      game.teamLocked = true;
      game.lockedTeam = team;
      const hq = this._pickHqSpawn(team);
      if (hq && game.world && game.world.setSelectedSpawn) {
        game.world.setSelectedSpawn(hq.id);
      }
      if (game.running && game.player) {
        if (game.player.respawn) game.player.respawn();
        if (game.player.applySelectedSpawn) game.player.applySelectedSpawn();
      }
      this._toast(
        '已换至' + (team === 'enemy' ? '红方' : '蓝方') + ' · 主基地重生'
      );
    },

    _onRosterChanged() {
      const other = this._expectedRemoteTeam();
      if (this.remoteLoadout) this.remoteLoadout.team = other;
      if (this._lockedRemoteLoadout) this._lockedRemoteLoadout.team = other;
      const game = global.VF && global.VF.game;
      if (game && game.ai && game.ai.syncHumanCounts) {
        game.ai.syncHumanCounts(this.getHumanCounts());
      }
      if (global.VF && global.VF.UI && global.VF.UI.syncTeamSwitchButton) {
        global.VF.UI.syncTeamSwitchButton();
      }
    },

    _toast(msg) {
      if (global.VF && global.VF.UI && global.VF.UI.toast) global.VF.UI.toast(msg);
    },
  };

  global.VF = global.VF || {};
  global.VF.Pvp = Pvp;
  Pvp.pickJoinTeam = pickJoinTeam;
  Pvp.canSwitchTeam = canSwitchTeam;
  Pvp.isServerJoinable = isServerJoinable;
  Pvp.pickBestJoinableServer = pickBestJoinableServer;
  Pvp.HUMAN_CAP = HUMAN_CAP;
  Pvp.HUMAN_PER_TEAM = HUMAN_PER_TEAM;
})(typeof window !== 'undefined' ? window : globalThis);
