export type RuntimePlayer = { id: string; name: string; isHost: boolean }
export type RuntimeRoom = {
  getRoomInfo(): { players: RuntimePlayer[]; status: string }
  setStatus(status: string): void
  broadcast(message: unknown): void
  sendToPlayer(id: string, message: unknown): void
}
export type RuntimePlatform = {
  useRoomService(options: {
    maxPlayers?: number
    onMessage?: (message: unknown, context: { playerId?: string; broadcast(message: unknown): void; sendToPlayer(id: string, message: unknown): void }) => void
    onPlayerJoin?: (player: RuntimePlayer) => void
    onPlayerLeave?: (id: string) => void
    onPlayerReconnect?: (id: string) => void
  }): RuntimeRoom
}

export type StateSyncGame<I = unknown, S = Record<string, unknown>, P = S, R = Record<string, unknown>> = {
  start(): void | Promise<void>
  stop(): void | Promise<void>
  tick(): boolean | Promise<boolean>
  applyAction(playerId: string, input: I): void | Promise<void>
  removePlayer(playerId: string): void | Promise<void>
  ensurePlayer?(player: RuntimePlayer): void | Promise<void>
  reconnectPlayer?(id: string): void | Promise<void>
  getPlayerCount(): number
  getState(playerId?: string): S
  getDelta(playerId: string, ackedSeq: number): P
  getResult(): R
}

export type StateSyncOptions<S, I, P, R> = {
  platform: RuntimePlatform
  roomPolicy: { maxPlayers: number; minPlayersToStart?: number; tickIntervalMs?: number; initialStatus?: string; playingStatus?: string; finishedStatus?: string }
  createGame(players: RuntimePlayer[]): StateSyncGame<I, S, P, R>
}

export function createPlatformStateSyncRuntime<S, I, P, R>(options: StateSyncOptions<S, I, P, R>): void {
  let game: StateSyncGame<I, S, P, R> | undefined
  let sequence = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const initial = options.roomPolicy.initialStatus ?? 'waiting'
  const playing = options.roomPolicy.playingStatus ?? 'playing'
  const finished = options.roomPolicy.finishedStatus ?? 'finished'
  const room = options.platform.useRoomService({
    maxPlayers: options.roomPolicy.maxPlayers,
    onPlayerJoin(player) { void game?.ensurePlayer?.(player) },
    onPlayerReconnect(id) { void game?.reconnectPlayer?.(id) },
    onPlayerLeave(id) { void game?.removePlayer(id) },
    onMessage(message, context) {
      const value = message as { type?: string; input?: I }
      if (!context.playerId) return
      if (value.type === 'start_game') {
        if (room.getRoomInfo().status !== initial) return
        const players = room.getRoomInfo().players
        if (players.length < (options.roomPolicy.minPlayersToStart ?? 1)) return
        const sender = players.find((p) => p.id === context.playerId)
        if (sender && !sender.isHost && players[0]?.id !== context.playerId) return
        game = options.createGame(players)
        if (value.input) void game.applyAction(context.playerId, value.input as I)
        void Promise.resolve(game.start()).then(() => {
          room.setStatus(playing)
          sequence = 0
          const state = game?.getState()
          room.broadcast({ type: 'game_init', state })
          room.broadcast({ type: 'game_update', seq: sequence, state })
          timer = setInterval(() => {
            if (!game) return
            void Promise.resolve(game.tick()).then((over) => {
              if (!game) return
              sequence += 1
              room.broadcast({ type: over ? 'game_over' : 'game_update', seq: sequence, state: over ? undefined : game.getState(), result: over ? game.getResult() : undefined })
              if (over) { clearInterval(timer); timer = undefined; room.setStatus(finished) }
            })
          }, options.roomPolicy.tickIntervalMs ?? 50)
        })
        return
      }
      if (!game) return
      if (value.type === 'input') void game.applyAction(context.playerId, value.input as I)
      else if (value.type === 'configure' || value.type === 'wire') void game.applyAction(context.playerId, value as I)
    },
  })
  room.setStatus(initial)
}

