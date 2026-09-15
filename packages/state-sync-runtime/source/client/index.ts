export type RoomPlayer = {
  id: string
  name: string
  isHost: boolean
  isMe: boolean
  seatIndex: number
}

export type RoomSnapshot = {
  id?: string
  players: RoomPlayer[]
  isReady: boolean
  isHost: boolean
}

export type RoomEventHandlers<S = unknown, R = unknown> = {
  onRoomUpdate?: (room: RoomSnapshot) => void
  onPlayerJoin?: (player: RoomPlayer) => void
  onPlayerLeave?: (playerId: string) => void
  onGameInit?: (state: S) => void
  onGameUpdate?: (state: S) => void
  onGameOver?: (result: R) => void
  onDisconnected?: (info?: { recoverable?: boolean }) => void
  onError?: (error: unknown) => void
}

export type RoomClient = {
  connect(options?: { join?: boolean | string; roomId?: string; playerName?: string; isHost?: boolean }): Promise<void>
  join(playerName?: string): void
  startGame(): void
  sendAction(input: unknown): void
  getPlayerId(): string
  disconnect(): void
  on(type: string, listener: (payload: any) => void): () => void
  getPlayers?(): RoomPlayer[]
  getSeatPlayer?(index: number): RoomPlayer | undefined
  getSeatDisplayName?(index: number, fallback?: string): string
  isRoomOwner?(): boolean
  subscribeEvents?(handlers: RoomEventHandlers<any, any>): () => void
  setEvents?(handlers: RoomEventHandlers<any, any>): () => void
}

declare global {
  var PlatformClient: {
    room?: () => RoomClient
    rooms?: {
      list(): Promise<any[]>
      get(roomId: string): Promise<any>
      create(options?: { name?: string; maxPlayers?: number; seat?: string; [key: string]: unknown }): Promise<{ room: { id: string }; created: boolean; connection?: RoomClient; token?: string }>
      join(roomId: string, options?: { playerName?: string; isHost?: boolean; seat?: string }): Promise<{ room: any; connection: RoomClient }>
      leave(roomId: string): Promise<any>
      destroy(roomId: string): Promise<void>
      connect(roomId: string, options?: { playerName?: string }): Promise<RoomClient>
    }
  } | undefined
}

export class OnlineRoomSession<I = unknown, S = Record<string, unknown>, R = Record<string, unknown>> {
  protected room: RoomClient | undefined
  private readonly listeners = new Map<string, Set<(payload: any) => void>>()
  private readonly subscribers = new Set<RoomEventHandlers<S, R>>()
  public roomId: string = ''
  public myPlayerId: string = ''
  public myPlayerName: string = ''
  public isHost: boolean = false
  public isReady: boolean = false
  public players: RoomPlayer[] = []
  public state: S | undefined
  public readonly minPlayersToStart: number

  constructor(options: { minPlayersToStart?: number; roomClient?: RoomClient } = {}) {
    this.minPlayersToStart = options.minPlayersToStart ?? 2
    if (options.roomClient) {
      this.bindRoom(options.roomClient)
    }
  }

  bindRoom(room: RoomClient, roomId = ''): void {
    this.room = room
    this.roomId = roomId
    this.myPlayerId = room.getPlayerId?.() ?? ''

    for (const type of ['welcome', 'room_update', 'game_init', 'game_update', 'game_over', 'game_paused', 'game_reset', 'pong', 'error', 'disconnected']) {
      room.on(type, (payload: any) => {
        if (type === 'welcome') {
          if (payload.playerId) this.myPlayerId = payload.playerId
          if (payload.playerName) this.myPlayerName = payload.playerName
          this.syncRoster()
        } else if (type === 'room_update') {
          this.syncRoster(payload.room?.players)
        }

        const state = (payload && typeof payload === 'object' && 'state' in payload) ? payload.state : payload
        if (type === 'game_init' || type === 'game_update') {
          this.state = state as S
        }

        this.emit(type, payload)
        if (type === 'game_init' || type === 'game_update') {
          this.emit('game_update', { state: this.state })
        }
        this.notifySubscribers(type, payload)
      })
    }
  }

  private syncRoster(remoteList?: Array<{ id: string; name?: string; isHost?: boolean }>): void {
    if (Array.isArray(remoteList)) {
      let foundMe = false
      this.players = remoteList.map((p, index) => {
        const isMe = p.id === this.myPlayerId || (Boolean(this.myPlayerId) && p.id === this.myPlayerId)
        if (isMe) foundMe = true
        return {
          id: p.id,
          name: p.name || (isMe ? (this.myPlayerName || '我') : `Player ${index + 1}`),
          isHost: Boolean(p.isHost),
          isMe,
          seatIndex: index,
        }
      })
      if (!foundMe && this.myPlayerId) {
        this.players.unshift({
          id: this.myPlayerId,
          name: this.myPlayerName || '我',
          isHost: this.isHost,
          isMe: true,
          seatIndex: 0,
        })
      }
    } else if (this.players.length === 0 && (this.myPlayerId || this.myPlayerName)) {
      this.players = [{
        id: this.myPlayerId,
        name: this.myPlayerName || '我',
        isHost: this.isHost,
        isMe: true,
        seatIndex: 0,
      }]
    }
    for (const p of this.players) {
      if (p.isMe) this.isHost = Boolean(p.isHost)
    }
    this.isReady = this.players.length >= this.minPlayersToStart
    this.notifySubscribers('room_update', { room: { id: this.roomId, players: this.players } })
  }

  public isRoomOwner(): boolean {
    return Boolean(this.isHost)
  }

  private notifySubscribers(type: string, payload: any): void {
    const state = (payload && typeof payload === 'object' && 'state' in payload) ? payload.state : payload
    const result = (payload && typeof payload === 'object' && 'result' in payload) ? payload.result : payload
    for (const sub of this.subscribers) {
      if (type === 'room_update' && sub.onRoomUpdate) {
        sub.onRoomUpdate({ id: this.roomId, players: [...this.players], isReady: this.isReady, isHost: this.isHost })
      } else if (type === 'game_init' && sub.onGameInit) {
        sub.onGameInit(state as S)
      } else if (type === 'game_update' && sub.onGameUpdate) {
        sub.onGameUpdate(state as S)
      } else if (type === 'game_over' && sub.onGameOver) {
        sub.onGameOver(result as R)
      } else if (type === 'disconnected' && sub.onDisconnected) {
        sub.onDisconnected(payload)
      } else if (type === 'error' && sub.onError) {
        sub.onError(payload)
      }
    }
  }

  /**
   * Safe multi-listener subscription. Multiple components (e.g. LobbyUI and GameScene)
   * can listen concurrently without overriding each other.
   */
  subscribeEvents(handlers: RoomEventHandlers<S, R>): () => void {
    this.subscribers.add(handlers)
    if (this.players.length > 0 && handlers.onRoomUpdate) {
      handlers.onRoomUpdate({ id: this.roomId, players: [...this.players], isReady: this.isReady, isHost: this.isHost })
    }
    return () => this.subscribers.delete(handlers)
  }

  /**
   * Defensive alias for setEvents:
   * Instead of wiping previous listeners and breaking other components,
   * setEvents safely registers via subscribeEvents and returns the unsubscribe function.
   */
  setEvents(handlers: RoomEventHandlers<S, R>): () => void {
    return this.subscribeEvents(handlers)
  }

  getSeatPlayer(index: number): RoomPlayer | undefined {
    return this.players[index]
  }

  getSeatDisplayName(index: number, fallback = '等待加入...'): string {
    const player = this.players[index]
    if (!player) return fallback
    return player.isMe ? `${player.name} (我)` : player.name
  }

  async listRooms(): Promise<any[]> {
    const rooms = globalThis.PlatformClient?.rooms
    if (!rooms?.list) return []
    // The room directory resolves to a paginated object
    // ({ rooms, total, page, pageSize, currentRoom }) both online and in the
    // local preview; tolerate a bare array defensively.
    const result = await rooms.list()
    if (Array.isArray(result)) return result
    const paginated = result as { rooms?: unknown } | null | undefined
    return Array.isArray(paginated?.rooms) ? paginated.rooms as any[] : []
  }

  async createRoom(options?: { name?: string; maxPlayers?: number; playerName?: string; seat?: string }): Promise<{ roomId: string }> {
    const rooms = globalThis.PlatformClient?.rooms
    if (!rooms?.create || !rooms?.join) throw new Error('PlatformClient.rooms is unavailable')
    const name = options?.name || 'Room 1'
    const maxPlayers = options?.maxPlayers || 4
    const playerName = options?.playerName || this.myPlayerName || 'Player'
    this.myPlayerName = playerName
    this.isHost = true

    const created = await rooms.create({ name, maxPlayers, seat: options?.seat })
    const roomId = created.room.id
    if (created.connection) {
      this.bindRoom(created.connection, roomId)
      this.myPlayerId = created.connection.getPlayerId?.() ?? ''
      this.syncRoster()
      await created.connection.connect({ roomId, playerName, isHost: true })
      return { roomId }
    }
    const joined = await rooms.join(roomId, { playerName, isHost: true })
    this.bindRoom(joined.connection, roomId)
    this.myPlayerId = joined.connection.getPlayerId?.() ?? ''
    this.syncRoster()
    await joined.connection.connect()
    return { roomId }
  }

  async joinRoom(roomId: string, options?: { playerName?: string; seat?: string }): Promise<void> {
    const rooms = globalThis.PlatformClient?.rooms
    if (!rooms?.join) throw new Error('PlatformClient.rooms is unavailable')
    const playerName = options?.playerName || this.myPlayerName || 'Player'
    this.myPlayerName = playerName

    const joined = await rooms.join(roomId, { playerName, isHost: false, seat: options?.seat })
    this.bindRoom(joined.connection, roomId)
    this.myPlayerId = joined.connection.getPlayerId?.() ?? ''
    this.syncRoster()
    await joined.connection.connect()
  }

  async connect(options?: { join?: boolean | string; roomId?: string; playerName?: string; isHost?: boolean }): Promise<void> {
    if (!this.room) {
      const factory = globalThis.PlatformClient?.room
      if (factory) {
        this.bindRoom(factory(), options?.roomId || 'single')
      }
    }
    if (!this.room) throw new Error('No room connection available to connect')
    if (options?.playerName) this.myPlayerName = options.playerName
    if (options?.isHost !== undefined) this.isHost = options.isHost
    this.syncRoster()
    return this.room.connect(options)
  }

  join(name?: string): void {
    if (name) this.myPlayerName = name
    this.syncRoster()
    this.room?.join(name)
  }

  startGame(): void { this.room?.startGame() }
  sendAction(input: I): void { this.room?.sendAction(input) }
  getPlayerId(): string { return this.myPlayerId || this.room?.getPlayerId() || '' }
  disconnect(): void { this.room?.disconnect() }
  on(type: string, listener: (payload: any) => void): () => void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
    return () => set.delete(listener)
  }
  private emit(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(payload)
  }
}

export class PlatformStateSyncClient<I = unknown, S = Record<string, unknown>, P = S, R = Record<string, unknown>, Room = unknown> extends OnlineRoomSession<I, S, R> {
  constructor(options: { applyPatch?: (state: S, patch: P) => S; minPlayersToStart?: number } = {}) {
    super({ minPlayersToStart: options.minPlayersToStart })
    void options.applyPatch
    const factory = globalThis.PlatformClient?.room
    if (factory) {
      this.bindRoom(factory())
    }
  }
}

export function createOnlineClient<I = unknown, S = Record<string, unknown>, R = Record<string, unknown>>(options?: { minPlayersToStart?: number }) {
  return new OnlineRoomSession<I, S, R>(options)
}

export function createGameClient<I = unknown, S = Record<string, unknown>, R = Record<string, unknown>>() {
  return new OnlineRoomSession<I, S, R>()
}
