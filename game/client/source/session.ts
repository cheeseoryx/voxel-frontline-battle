import { initialize, rooms } from 'zaohua-platform-sdk'
import { OnlineClient } from './multiplayer'
import { MODE_SPECS, specFor, resolveMode, type ModeId } from '../../shared/modes'
import type { MatchState, WireMessage } from '../../shared/protocol'

type PvpLike = {
  mode: string | null
  roomCode: string | null
  connected: boolean
  remotePresent: boolean
  _busClientId: string
  _destroyed: boolean
  _lobbyDone: boolean
  skipSpawnGate: boolean
  humanRoster: { ally: string[]; enemy: string[] } | null
  localTeam: string
  matchSeed: number | null
  phase: string | null
  _serverInfo: Record<string, unknown> | null
  _quickBusy?: boolean
  quickSession?: boolean
  _quickPending?: { mode?: string }
  _pendingStart?: WireMessage | null
  remoteState: Record<string, unknown> | null
  remoteStates?: Record<string, Record<string, unknown>>
  els: {
    joinErr?: HTMLElement | null
    joinCode?: HTMLInputElement | null
    lobbyOverlay?: HTMLElement | null
    joinOverlay?: HTMLElement | null
  }
  createRoom(opts?: Record<string, unknown>): unknown
  joinRoom(code?: string, opts?: Record<string, unknown>): unknown
  listServers?(): Array<Record<string, unknown>>
  quickMatch?(mode?: string, code?: string): unknown | Promise<boolean>
  leaveLobby?(opts?: Record<string, unknown>): unknown
  destroySession(): unknown
  enterQuickBattle?(loadout: unknown, onEnter?: unknown): unknown
  _enterBattlefield?(data: unknown): unknown
  _send(obj: WireMessage): unknown
  _beginMatchFromNet(data: WireMessage): unknown
  _hideCover(): unknown
  _showCover(): unknown
  _toast(text: string): unknown
  _ensureLocalRosterTeam(): string
  _startSides(): { hostTeam: string; guestTeam: string }
  _rosterTeamOf(id: string): string | null
  _onData(data: WireMessage): unknown
}

declare global {
  interface Window {
    VF?: {
      Pvp?: PvpLike
      ZaohuaOnline?: ZaohuaSession
      NetSimulation?: { receive?: (message: unknown) => boolean }
      UI?: { toast?: (text: string) => void; openModeSelect?: () => void }
    }
    VFEntry?: {
      hideTransition?: () => void
      goLobby?: () => void
    }
  }
}

function toast(pvp: PvpLike | undefined, text: string): void {
  if (pvp && typeof pvp._toast === 'function') pvp._toast(text)
  else if (window.VF?.UI?.toast) window.VF.UI.toast(text)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** The SDK throws this when no host runtime backs the room directory (plain page, no preview). */
function roomServiceMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes('PlatformClient.rooms is unavailable')
}

function roomJoinId(room: Record<string, unknown>): string {
  return String(room.id || room.room_id || room.roomId || room.room_code || room.code || '')
}

function roomCodeOf(room: Record<string, unknown>): string {
  return String(room.room_code || room.code || roomJoinId(room)).toUpperCase()
}

function playerCount(room: Record<string, unknown>): number {
  if (Array.isArray(room.players)) return room.players.length
  if (Array.isArray(room.playerIds)) return room.playerIds.length
  const n = Number(room.players)
  return Number.isFinite(n) ? n : 0
}

function modeFromRoom(room: Record<string, unknown>, fallback: ModeId): ModeId {
  if (room.mode) return resolveMode(room.mode)
  const name = String(room.name || '')
  for (const spec of Object.values(MODE_SPECS)) {
    if (name.includes(spec.label)) return spec.id
  }
  return fallback
}

function bindFn(obj: object, name: string): ((...args: never[]) => unknown) | null {
  const fn = (obj as Record<string, unknown>)[name]
  return typeof fn === 'function' ? (fn as (...args: never[]) => unknown).bind(obj) : null
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function clearLoadingChrome(): void {
  const status = document.getElementById('frontline-match-status')
  if (status) status.remove()
  if (window.VFEntry && typeof window.VFEntry.hideTransition === 'function') {
    window.VFEntry.hideTransition()
  }
}

export class ZaohuaSession {
  readonly ready: Promise<boolean>
  client: OnlineClient<WireMessage | { type: string; [key: string]: unknown }, MatchState> | null = null
  active = false
  lastEventId = 0
  cachedServers: Array<Record<string, unknown>> = []
  private installed = false
  private starting = false
  private pvp: PvpLike | null = null
  private pendingMode: ModeId = 'conquest'
  private pendingQuick = false
  private pendingSeed = 0
  private pendingMap = specFor('conquest').map
  private gameStarted = false
  private wantStartGame = false
  private origDestroy: ((...args: never[]) => unknown) | null = null
  private injectedJoinTried = false

  constructor() {
    this.ready = this.boot()
    void this.ready.then((ok) => {
      if (ok) void this.refreshServers({ joinInjected: true })
    })
  }

  isPlaying(): boolean {
    return this.active && !!this.client
  }

  async boot(): Promise<boolean> {
    try {
      await withTimeout(initialize({ capabilities: ['game.multiplayer'] }), 8000, '平台初始化超时')
      return true
    } catch (error) {
      console.warn('[zaohua] initialize failed', error)
      return false
    }
  }

  install(pvp: PvpLike): void {
    if (this.installed || !pvp) return
    const origDestroy = bindFn(pvp, 'destroySession')
    const origSend = bindFn(pvp, '_send')
    if (!origDestroy) return
    this.installed = true
    this.pvp = pvp
    const session = this
    const origLeave = bindFn(pvp, 'leaveLobby')
    const origEnterBattle = bindFn(pvp, '_enterBattlefield')
    const origEnterQuick = bindFn(pvp, 'enterQuickBattle')
    this.origDestroy = origDestroy

    pvp.createRoom = function (opts) {
      void session.createRoom(opts || {})
    }

    pvp.joinRoom = function (code, opts) {
      void session.joinRoom(String(code || (this.els.joinCode && this.els.joinCode.value) || ''), opts || {})
      return true
    }

    pvp.listServers = function () {
      void session.refreshServers({ joinInjected: false })
      return session.cachedServers
    }

    pvp.quickMatch = function (mode, code) {
      return session.quickMatch(mode, code)
    }

    pvp.leaveLobby = function (opts) {
      const roomId = session.client?.roomId
      const result = origLeave ? origLeave(opts as never) : origDestroy()
      void session.leavePlatform(roomId)
      return result
    }

    pvp.destroySession = function () {
      const roomId = session.client?.roomId
      const result = origDestroy()
      session.detach(true)
      void session.leavePlatform(roomId)
      return result
    }

    pvp._send = function (obj) {
      if (session.client) {
        session.client.sendAction({ type: 'wire', message: { ...obj } })
      }
    }

    if (origEnterBattle) {
      pvp._enterBattlefield = function (data) {
        session.notifyLocalEnter()
        return origEnterBattle(data as never)
      }
    }

    if (origEnterQuick) {
      pvp.enterQuickBattle = function (loadout, onEnter) {
        session.notifyLocalEnter()
        return origEnterQuick(loadout as never, onEnter as never)
      }
    }
  }

  notifyLocalEnter(): void {
    this.wantStartGame = true
    this.flushStartGame()
  }

  async refreshServers(opts: { joinInjected?: boolean } = {}): Promise<void> {
    const ok = await this.ready
    if (!ok) return
    try {
      const listedRaw = await rooms.list({ pageSize: 100, page_size: 100 })
      const listed = asRecord(listedRaw)
      const rows = Array.isArray(listedRaw) ? listedRaw : listed.rooms
      const extra = listed.currentRoom ? [listed.currentRoom] : []
      const byId = new Map<string, Record<string, unknown>>()
      for (const item of [...(Array.isArray(rows) ? rows : []), ...extra]) {
        const room = asRecord(item)
        const id = roomJoinId(room)
        if (id) byId.set(id, room)
      }
      this.cachedServers = [...byId.values()].map((room) => this.toServerRow(room))
      const injected = roomJoinId(asRecord(listed.currentRoom))
      if (opts.joinInjected && injected && !this.client?.roomId && !this.injectedJoinTried) {
        this.injectedJoinTried = true
        void this.joinRoom(injected)
      }
    } catch (error) {
      console.warn('[zaohua] list rooms failed', error)
    }
  }

  async createRoom(opts: Record<string, unknown>): Promise<boolean> {
    const ok = await this.ready
    const pvp = this.pvp
    if (!ok || !pvp) {
      toast(pvp || undefined, '联机需要在造化预览或平台中运行')
      this.restoreLobby()
      return false
    }
    if (this.starting) return true
    this.starting = true
    try {
      await this.resetLocal(pvp)
      const mode = resolveMode(opts.mode || pvp._quickPending?.mode || this.pendingMode)
      const spec = specFor(mode)
      this.pendingMode = mode
      this.pendingQuick = !!opts.quick || mode !== 'conquest'
      this.pendingMap = spec.map
      this.pendingSeed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0
      const name = (opts.quick ? '匹配房间' : '社区对战服务器') + ' · ' + spec.label
      const playerName = this.playerName()
      const client = this.makeClient()
      await withTimeout(
        client.createRoom({ name, maxPlayers: spec.maxPlayers, playerName }),
        12000,
        '创建房间超时',
      )
      this.active = true
      if (client.myPlayerId) pvp._busClientId = client.myPlayerId
      pvp._serverInfo = {
        name,
        map: spec.map,
        mode,
        modeLabel: spec.label,
        createdAt: Date.now(),
        source: opts.quick ? 'quick' : 'create',
      }
      if (this.pendingQuick) {
        pvp.quickSession = true
        pvp._quickPending = { mode }
      }
      this.applyLocalSeat(pvp, 'host', client.roomId)
      this.cachedServers = [
        this.toServerRow({
          id: client.roomId,
          room_code: client.roomId,
          name,
          mode,
          map: spec.map,
          maxPlayers: spec.maxPlayers,
          status: 'waiting',
        }),
      ]
      console.info('[zaohua] room created', client.roomId)
      this.enterLocalPrep(pvp, 'host')
      toast(pvp, '房间已创建')
      void this.refreshServers()
      return true
    } catch (error) {
      console.warn('[zaohua] createRoom failed', error)
      toast(
        pvp,
        roomServiceMissing(error)
          ? '未连接造化平台 · 联机不可用'
          : '创建房间失败：' + (error instanceof Error ? error.message : String(error)),
      )
      this.detach(true)
      this.restoreLobby()
      return false
    } finally {
      this.starting = false
    }
  }

  async joinRoom(code: string, opts: Record<string, unknown> = {}): Promise<boolean> {
    const ok = await this.ready
    const pvp = this.pvp
    if (!ok || !pvp) {
      toast(pvp || undefined, '联机需要在造化预览或平台中运行')
      return false
    }
    const raw = String(code || '').trim()
    if (!raw) {
      if (pvp.els.joinErr) pvp.els.joinErr.textContent = '请输入有效房间码'
      return false
    }
    try {
      await this.resetLocal(pvp)
      const listed = this.cachedServers.find(
        (server) => String(server.id) === raw || String(server.code) === raw.toUpperCase(),
      )
      const roomId = listed ? String(listed.id || listed.code) : raw
      if (listed && listed.mode) this.pendingMode = resolveMode(listed.mode)
      this.pendingQuick = this.pendingMode !== 'conquest' || this.pendingQuick
      const spec = specFor(this.pendingMode)
      this.pendingMap = spec.map
      if (!this.pendingSeed) this.pendingSeed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0
      const client = this.makeClient()
      await withTimeout(client.joinRoom(roomId, { playerName: this.playerName() }), 12000, '加入房间超时')
      this.active = true
      if (client.myPlayerId) pvp._busClientId = client.myPlayerId
      if (this.pendingQuick) {
        pvp.quickSession = true
        pvp._quickPending = { mode: this.pendingMode }
      }
      this.applyLocalSeat(pvp, 'guest', client.roomId || roomId)
      this.enterLocalPrep(pvp, 'guest')
      toast(pvp, '已加入房间')
      return true
    } catch (error) {
      console.warn('[zaohua] joinRoom failed', error)
      if (!opts.silentFail) toast(pvp, '房间不存在或已关闭')
      this.detach(true)
      this.restoreLobby()
      return false
    }
  }

  /** Resolves false when the platform room service is unusable, so callers can fall back to a local match. */
  async quickMatch(mode?: string, code?: string): Promise<boolean> {
    const pvp = this.pvp
    if (!pvp) return false
    if (pvp._quickBusy) return true
    pvp._quickBusy = true
    try {
      this.pendingMode = resolveMode(mode || 'conquest')
      this.pendingQuick = this.pendingMode !== 'conquest'
      pvp._quickPending = { mode: this.pendingMode }
      await this.refreshServers()
      const spec = specFor(this.pendingMode)
      const want = String(code || '').trim()
      const open = this.cachedServers.filter((server) => {
        if (server.mode && server.mode !== spec.id) return false
        if (server.phase === 'closed') return false
        return Number(server.players) < Number(server.capacity)
      })
      const best = want
        ? open.find((server) => String(server.code) === want.toUpperCase() || String(server.id) === want)
        : open[0]
      if (best) {
        toast(pvp, '正在加入 ' + String(best.name || best.code))
        const joined = await this.joinRoom(String(best.id || best.code), { silentFail: true })
        if (joined) return true
        toast(pvp, '房间无法加入 · 正在创建匹配房间')
      }
      return this.createRoom({ quick: true, mode: spec.id })
    } finally {
      pvp._quickBusy = false
    }
  }

  private makeClient(): OnlineClient<WireMessage | { type: string; [key: string]: unknown }, MatchState> {
    const client = new OnlineClient({ minPlayersToStart: 1 })
    this.bindClient(client)
    this.client = client
    this.gameStarted = false
    this.wantStartGame = false
    this.active = false
    return client
  }

  private async resetLocal(pvp: PvpLike): Promise<void> {
    const previous = this.client?.roomId
    if (this.origDestroy) this.origDestroy()
    this.detach(true)
    await this.leavePlatform(previous)
    pvp._destroyed = false
  }

  private async leavePlatform(roomId: string | undefined): Promise<void> {
    if (!roomId) return
    try {
      await rooms.leave(roomId)
    } catch (error) {
      console.warn('[zaohua] leave failed', error)
    }
  }

  private enterLocalPrep(pvp: PvpLike, role: 'host' | 'guest'): void {
    pvp._destroyed = false
    pvp.mode = role
    pvp.skipSpawnGate = true
    pvp.connected = true
    pvp._lobbyDone = false
    pvp.matchSeed = this.pendingSeed
    if (typeof pvp._ensureLocalRosterTeam === 'function' && !pvp._rosterTeamOf(pvp._busClientId)) {
      pvp._ensureLocalRosterTeam()
    }
    const sides =
      typeof pvp._startSides === 'function' ? pvp._startSides() : { hostTeam: 'ally', guestTeam: 'enemy' }
    const payload: WireMessage = {
      type: 'start',
      seed: this.pendingSeed,
      hostTeam: sides.hostTeam,
      guestTeam: sides.guestTeam,
      fromId: pvp._busClientId,
      roster: pvp.humanRoster || undefined,
      matchMode: this.pendingMode,
      quick: this.pendingQuick,
      map: this.pendingMap,
    }
    pvp._pendingStart = payload
    if (pvp.els.joinOverlay) pvp.els.joinOverlay.classList.add('hidden')
    if (pvp.els.lobbyOverlay) pvp.els.lobbyOverlay.classList.add('hidden')
    pvp._hideCover()
    clearLoadingChrome()
    try {
      pvp._beginMatchFromNet(payload)
    } catch (error) {
      console.warn('[zaohua] enter prep failed', error)
      toast(pvp, '进入整备失败：' + (error instanceof Error ? error.message : String(error)))
    }
    clearLoadingChrome()
  }

  private flushStartGame(): void {
    if (!this.wantStartGame || this.gameStarted || !this.client) return
    if (!this.client.roomId) return
    if (!this.client.isRoomOwner()) return
    this.gameStarted = true
    this.client.startGame()
    this.client.sendAction({
      type: 'configure',
      mode: this.pendingMode,
      seed: this.pendingSeed,
      quick: this.pendingQuick,
      map: this.pendingMap,
    })
  }

  private restoreLobby(): void {
    clearLoadingChrome()
    const ui = window.VF && window.VF.UI
    if (ui && typeof ui.openModeSelect === 'function') ui.openModeSelect()
    else if (window.VFEntry && typeof window.VFEntry.goLobby === 'function') window.VFEntry.goLobby()
  }

  private bindClient(client: OnlineClient<WireMessage | { type: string; [key: string]: unknown }, MatchState>): void {
    this.lastEventId = 0
    client.subscribeEvents({
      onRoomUpdate: (room) => this.onRoom(room.players),
      onGameInit: (state) => this.onState(state),
      onGameUpdate: (state) => this.onState(state),
      onGameOver: (result) => {
        const pvp = this.pvp
        if (pvp && result && typeof result === 'object' && 'winner' in (result as object)) {
          pvp._onData({
            type: 'winner',
            winnerTeam: (result as { winner?: string }).winner,
            reason: (result as { reason?: string }).reason || '',
          })
        }
      },
    })
  }

  private onRoom(players: Array<{ id: string; isMe?: boolean; isHost?: boolean }>): void {
    const pvp = this.pvp
    if (!pvp || !this.client) return
    pvp.connected = true
    pvp.remotePresent = players.some((player) => !player.isMe)
    if (this.client.myPlayerId) pvp._busClientId = this.client.myPlayerId
    pvp.mode = this.client.isRoomOwner() ? 'host' : pvp.mode || 'guest'
    this.flushStartGame()
  }

  private onState(state: MatchState | undefined): void {
    const pvp = this.pvp
    if (!pvp || !state) return
    pvp.connected = true
    pvp.humanRoster = state.roster
    if (state.seed) pvp.matchSeed = state.seed
    const me = this.client?.myPlayerId || pvp._busClientId
    if (state.roster) {
      if ((state.roster.ally || []).includes(me)) pvp.localTeam = 'ally'
      else if ((state.roster.enemy || []).includes(me)) pvp.localTeam = 'enemy'
    }
    pvp.remoteStates = state.players || {}
    const others = Object.values(state.players || {}).filter((player) => player.id !== me)
    pvp.remotePresent = others.length > 0
    pvp.remoteState = others[0] || pvp.remoteState
    for (const event of state.events || []) {
      if (event.id <= this.lastEventId) continue
      this.lastEventId = event.id
      const message = { ...event.message }
      if (message.fromId && message.fromId === me && message.type !== 'roster' && message.type !== 'start') continue
      if (message.type === 'state' && message.fromId === me) continue
      if (message.type === 'start' && pvp._lobbyDone) continue
      pvp._onData(message)
    }
    this.applyConquest(state)
  }

  private applyConquest(state: MatchState): void {
    const net = window.VF && window.VF.NetSimulation
    if (!net || typeof net.receive !== 'function') return
    const snapshot = {
      version: 1,
      matchId: state.matchId,
      phase: state.winner ? 'ended' : 'running',
      active: true,
      ended: !!state.winner,
      endReason: state.endReason,
      winner: state.winner,
      tickets: state.tickets,
      ticketsMax: state.ticketsMax,
      elapsed: state.elapsed,
      roundSec: state.roundSec,
      sweepSec: 60,
      sweep: { ally: 0, enemy: 0 },
      flags: state.flags,
    }
    net.receive({
      type: 'conquest-snapshot',
      protocol: 3,
      matchId: state.matchId,
      seq: Math.max(1, state.seq || 1),
      ack: 0,
      sentAt: Date.now(),
      payload: {
        snapshot,
        checksum: windowChecksum(snapshot),
      },
    })
  }

  private applyLocalSeat(pvp: PvpLike, role: 'host' | 'guest', roomId: string): void {
    pvp._destroyed = false
    pvp.mode = role
    pvp.skipSpawnGate = true
    pvp.connected = true
    pvp.roomCode = roomCodeOf({ id: roomId, room_code: roomId })
  }

  private playerName(): string {
    const el = document.getElementById('mode-player-name')
    const text = el && el.textContent ? el.textContent.trim() : ''
    return text || '指挥官'
  }

  private toServerRow(room: Record<string, unknown>): Record<string, unknown> {
    const spec = specFor(modeFromRoom(room, this.pendingMode))
    const capacity = Number(room.maxPlayers || room.max_players || spec.maxPlayers)
    const players = Math.max(1, playerCount(room))
    const status = String(room.status || 'waiting')
    return {
      id: roomJoinId(room),
      code: roomCodeOf(room),
      name: String(room.name || spec.label + ' · ' + roomCodeOf(room)),
      map: String(room.map || spec.map),
      mode: spec.id,
      modeLabel: spec.label,
      size: capacity,
      sizeLabel: spec.sizeLabel,
      players,
      capacity,
      ping: null,
      official: true,
      password: false,
      phase: status === 'finished' ? 'closed' : status === 'playing' ? 'play' : 'lobby',
      createdAt: Number(room.createdAt || Date.now()),
    }
  }

  private detach(disconnect: boolean): void {
    if (disconnect && this.client) {
      try {
        this.client.disconnect()
      } catch {
        /* ignore */
      }
    }
    this.client = null
    this.active = false
    this.gameStarted = false
    this.wantStartGame = false
    this.lastEventId = 0
  }
}

function windowChecksum(snapshot: Record<string, unknown>): string {
  const protocol = (window as unknown as { VF?: { NetProtocol?: { checksum?: (value: unknown) => string } } }).VF
  if (protocol && protocol.NetProtocol && protocol.NetProtocol.checksum) {
    return protocol.NetProtocol.checksum(snapshot)
  }
  return '0'
}

export function installZaohuaOnline(): ZaohuaSession {
  const session = new ZaohuaSession()
  const assign = () => {
    window.VF = window.VF || {}
    window.VF.ZaohuaOnline = session
    if (window.VF.Pvp) session.install(window.VF.Pvp)
  }
  assign()
  document.addEventListener('DOMContentLoaded', assign)
  window.addEventListener('load', assign)
  return session
}
