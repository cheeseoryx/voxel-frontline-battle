import { createPlatformStateSyncRuntime, type RuntimePlayer, type StateSyncGame } from '../../../packages/state-sync-runtime/source/server/index.ts'
import { MatchKernel } from './kernel'
import type { ClientAction, MatchState, WireMessage } from '../../shared/protocol'

const platform = globalThis.PlatformServer
if (!platform) throw new Error('PlatformServer was not injected by Game Builder PreviewHost')

type Game = StateSyncGame<ClientAction | WireMessage, MatchState, MatchState, ReturnType<MatchKernel['getResult']>> & {
  ensurePlayer(player: RuntimePlayer): void
  reconnectPlayer(id: string): void
}

function createGame(players: RuntimePlayer[]): Game {
  const kernel = new MatchKernel(players)
  let flushed = 0
  const game: Game = {
    start() {
      kernel.start()
    },
    stop() {
      kernel.stop()
    },
    tick() {
      const over = kernel.tick(0.05)
      const state = kernel.getState()
      flushed = state.events.length
      void flushed
      return over
    },
    applyAction(playerId, input) {
      kernel.ensurePlayer({ id: playerId, name: playerId, isHost: false })
      kernel.applyAction(playerId, input)
    },
    removePlayer(playerId) {
      kernel.removePlayer(playerId)
    },
    ensurePlayer(player) {
      kernel.ensurePlayer(player)
    },
    reconnectPlayer(id) {
      kernel.reconnectPlayer(id)
    },
    getPlayerCount() {
      return kernel.getPlayerCount()
    },
    getState() {
      return kernel.getState()
    },
    getDelta() {
      return kernel.getDelta()
    },
    getResult() {
      return kernel.getResult()
    },
  }
  return game
}

createPlatformStateSyncRuntime({
  platform,
  roomPolicy: { maxPlayers: 16, minPlayersToStart: 1, tickIntervalMs: 50 },
  createGame,
})
