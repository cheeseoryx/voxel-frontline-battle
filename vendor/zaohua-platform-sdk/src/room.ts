/* Generated from packages/vag-platform-sdk. Do not edit; run pnpm run build. */
/**
 * Multiplayer room surface of the platform SDK.
 *
 * Owns the room directory types and the capability-gated `rooms` client that
 * delegates to the host-injected PlatformClient. Connection transports live in
 * the host runtimes (offline preview injected runtime / published platform
 * client bundle), not here.
 */
import type { Capability } from './contracts.js'

export type RoomInfo = { id: string; name: string; status: string; ownerId?: string; maxPlayers?: number; playerIds?: string[]; players?: unknown[]; createdAt: number }
export type RoomConnection = {
  connect(options?: { join?: boolean | string; playerName?: string }): Promise<void>
  join(playerName?: string): void
  startGame(): void
  sendAction(input: unknown): void
  getPlayerId(): string
  disconnect(): void
  on(type: string, listener: (payload: any) => void): () => void
}
export type RoomDirectoryClient = {
  list(options?: { gameId?: string; game_id?: string; query?: string; page?: number; pageSize?: number; page_size?: number }): Promise<RoomInfo[] | { rooms: RoomInfo[]; total: number; page: number; pageSize: number; currentRoom?: unknown }>
  get(roomId: string): Promise<RoomInfo>
  create(options?: { name?: string; password?: string; maxPlayers?: number; max_players?: number; gameId?: string; game_id?: string; [key: string]: unknown }): Promise<{ room: RoomInfo; created: boolean; connection?: RoomConnection; token?: string } | RoomInfo>
  join(roomId: string, options?: { playerName?: string; password?: string; inviteToken?: string; invite_token?: string; isHost?: boolean }): Promise<{ room: RoomInfo; connection: RoomConnection }>
  leave(roomId: string): Promise<unknown>
  destroy(roomId: string): Promise<unknown>
  connect(roomId: string, options?: { playerName?: string }): Promise<RoomConnection>
}

export type RoomClientAccess = {
  requireCapability(capability: Capability): void
  platformClient(): { rooms?: RoomDirectoryClient }
}

/** Capability-gated room directory client delegating to PlatformClient.rooms. */
export function createRoomDirectoryClient(access: RoomClientAccess): RoomDirectoryClient {
  const { requireCapability, platformClient } = access
  const delegate = (): RoomDirectoryClient => {
    const rooms = platformClient().rooms
    if (!rooms) throw new Error('PlatformClient.rooms is unavailable')
    return rooms
  }
  return {
    list: async (options) => { requireCapability('game.multiplayer'); return await delegate().list(options) },
    get: async (roomId) => {
      requireCapability('game.multiplayer'); return await delegate().get(roomId)
    },
    create: async (options) => {
      requireCapability('game.multiplayer'); return await delegate().create(options)
    },
    join: async (roomId, options) => {
      requireCapability('game.multiplayer'); return await delegate().join(roomId, options)
    },
    leave: async (roomId) => {
      requireCapability('game.multiplayer'); return await delegate().leave(roomId)
    },
    destroy: async (roomId) => {
      requireCapability('game.multiplayer'); return await delegate().destroy(roomId)
    },
    connect: async (roomId, options) => {
      requireCapability('game.multiplayer'); return await delegate().connect(roomId, options)
    },
  }
}

/** No-op room connection used when no host container is present. */
export function createStandaloneRoomConnection(): RoomConnection {
  const listeners = new Map<string, Set<(payload: any) => void>>()
  return {
    connect: async () => {},
    join: () => {},
    startGame: () => {},
    sendAction: () => {},
    getPlayerId: () => 'standalone-player',
    disconnect: () => {},
    on: (type: string, listener: (payload: any) => void) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
      return () => set.delete(listener)
    },
  }
}

/**
 * Room directory used when no host runtime is present (standalone page, no
 * published bundle, no builder preview). Multiplayer is genuinely
 * unavailable: fail loudly instead of returning fake rooms that mask a
 * missing runtime.
 */
const standaloneRoomDirectories = new WeakSet<RoomDirectoryClient>()

export function isStandaloneRoomDirectory(rooms: RoomDirectoryClient | undefined): boolean {
  return Boolean(rooms && standaloneRoomDirectories.has(rooms))
}

export function createStandaloneRoomDirectory(): RoomDirectoryClient {
  const unavailable = (): never => {
    throw new Error(
      "PlatformClient.rooms is unavailable: multiplayer needs a host runtime (published bundle or builder preview)",
    );
  };
  const directory: RoomDirectoryClient = {
    list: async () => unavailable(),
    get: async () => unavailable(),
    create: async () => unavailable(),
    join: async () => unavailable(),
    leave: async () => unavailable(),
    destroy: async () => unavailable(),
    connect: async () => unavailable(),
  };
  standaloneRoomDirectories.add(directory)
  return directory
}
