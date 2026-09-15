/* Generated from packages/vag-platform-sdk. Do not edit; run pnpm run build. */
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  OFFLINE_PROTOCOL,
  REQUIRED_CAPABILITIES,
  type Capability,
} from './contracts.js'

export { CAPABILITIES, CONTRACT_VERSION, OFFLINE_PROTOCOL, REQUIRED_CAPABILITIES }
export type { Capability }
export type User = { id: string; name: string; avatar?: string }
export type { RoomInfo, RoomConnection, RoomDirectoryClient } from './room.js'
import { createRoomDirectoryClient, createStandaloneRoomConnection, createStandaloneRoomDirectory, isStandaloneRoomDirectory, type RoomDirectoryClient } from './room.js'
export type LifecycleState = { paused: boolean }
export type LifecycleAdapter = {
  pause(): void | Promise<void>
  resume(): void | Promise<void>
  getState(): LifecycleState
}
export type StudioLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type InitializeOptions = { capabilities: readonly Capability[] }
export type { FpsController, FpsOptions, FpsStats } from './fps.js'
import { createFpsController, type FpsOptions, type FpsStats } from './fps.js'

type OfflineEnvelope = {
  protocol: typeof OFFLINE_PROTOCOL
  contractVersion: typeof CONTRACT_VERSION
  sessionId: string
  type: string
  requestId?: string
  payload?: unknown
}

type PlatformClientGlobal = {
  __selfContained?: boolean
  bridge?: { ping?: () => Promise<unknown> | unknown }
  game?: {
    loading?: (detail?: unknown) => void
    loaded?: () => void
    onPause?: (handler: () => void) => () => void
    onResume?: (handler: () => void) => () => void
  }
  getUserInfo?: () => Promise<Record<string, unknown> | null>
  getCloudData?: (key: string) => Promise<unknown>
  saveCloudData?: (key: string, value: unknown) => Promise<void>
  room?: () => {
    connect(options?: { join?: boolean | string }): Promise<void>
    join(playerName?: string): void
    startGame(): void
    sendAction(input: unknown): void
    getPlayerId(): string
    disconnect(): void
    on(type: string, listener: (payload: any) => void): () => void
  }
  rooms?: RoomDirectoryClient
  studio?: {
    ping?: () => Promise<unknown> | unknown
    log?: (level: StudioLogLevel, message: string, detail?: unknown) => void
  }
}

type KubeeGameBridgeGlobal = {
  postMessage?: (message: string) => void
}

type StudioGlobal = {
  ping?: () => Promise<unknown> | unknown
  log?: (level: StudioLogLevel, message: string, detail?: unknown) => void
}

declare global {
  interface Window {
    PlatformClient?: PlatformClientGlobal
    FXclient?: PlatformClientGlobal
    KubeeGameBridge?: KubeeGameBridgeGlobal
    DukoStudio?: StudioGlobal
    __ZAOHUA_OFFLINE_SESSION__?: string
  }
}

let initialized = false
let declaredCapabilities = new Set<Capability>()
let lifecycleAdapter: LifecycleAdapter | undefined
let removeOnlinePause: (() => void) | undefined
let removeOnlineResume: (() => void) | undefined
const automaticFpsController = createFpsController()

window.addEventListener('message', (event) => {
  const message = event.data as { type?: string; payload?: { intervalMs?: number } } | undefined
  if (message?.type === 'VAG_START_FPS') {
    automaticFpsController.start({
      intervalMs: message.payload?.intervalMs,
      onStats: reportFpsStats,
    })
    return
  }
  if (message?.type === 'VAG_STOP_FPS') {
    automaticFpsController.stop()
    return
  }
  void acceptLifecycleRequest(event as MessageEvent<OfflineEnvelope>).catch((error: unknown) => {
    report('runtime.error', { message: errorMessage(error), source: 'lifecycle' })
  })
})

export const fps = {
  start(options: FpsOptions = {}): void {
    automaticFpsController.start(options)
  },
  stop(): void {
    automaticFpsController.stop()
  },
  getStats(): FpsStats | null {
    return automaticFpsController.getStats()
  },
}

if (isEmbeddedGame()) {
  automaticFpsController.start({ intervalMs: 300, onStats: reportFpsStats })
}

export async function initialize(options: InitializeOptions): Promise<void> {
  if (initialized) return
  const capabilities = normalizeCapabilities(options.capabilities)
  const platform = platformClient()
  await platform.bridge?.ping?.()
  await window.DukoStudio?.ping?.()
  declaredCapabilities = new Set(capabilities)
  initialized = true
  report('sdk.initialized', { capabilities })

  try {
    if (declaredCapabilities.has('user.current')) await user.getCurrent()
    if (declaredCapabilities.has('storage')) await validateStorageRoundTrip()
    if (declaredCapabilities.has('studio.logging')) studio.log('debug', 'Zaohua Studio logging connected')
  } catch (error) {
    report('runtime.error', { message: errorMessage(error), source: 'capability-initialization' })
    throw error
  }
}

export const game = {
  loading(detail?: unknown): void {
    requireCapability('game.loading')
    platformClient().game?.loading?.(detail)
    report('game.loading', detail)
  },
  loaded(): void {
    requireCapability('game.loading')
    platformClient().game?.loaded?.()
    report('game.loaded')
  },
}

export const lifecycle = {
  register(adapter: LifecycleAdapter): () => void {
    requireCapability('game.lifecycle')
    lifecycleAdapter = adapter
    removeOnlinePause?.()
    removeOnlineResume?.()
    removeOnlinePause = platformClient().game?.onPause?.(() => { void adapter.pause() })
    removeOnlineResume = platformClient().game?.onResume?.(() => { void adapter.resume() })
    report('lifecycle.registered', adapter.getState())
    return () => {
      if (lifecycleAdapter === adapter) lifecycleAdapter = undefined
      removeOnlinePause?.()
      removeOnlineResume?.()
      removeOnlinePause = undefined
      removeOnlineResume = undefined
    }
  },
}

export const user = {
  async getCurrent(): Promise<User> {
    requireCapability('user.current')
    const value = await platformClient().getUserInfo?.()
    const result = normalizeUser(value)
    report('user.current.succeeded', result)
    return result
  },
}

export const storage = {
  async get(key: string): Promise<unknown> {
    requireCapability('storage')
    return await platformClient().getCloudData?.(key)
  },
  async set(key: string, value: unknown): Promise<void> {
    requireCapability('storage')
    await platformClient().saveCloudData?.(key, value)
  },
}

export const rooms: RoomDirectoryClient = createRoomDirectoryClient({ requireCapability, platformClient })

export const studio = {
  log(level: StudioLogLevel, message: string, detail?: unknown): void {
    if (!initialized) throw new Error('Call initialize() before using vag-platform-sdk')
    window.DukoStudio?.log?.(level, message, detail)
    if (!window.DukoStudio?.log) console[level](message, detail)
    report(level === 'error' ? 'studio.error' : 'studio.log', { level, message, detail })
  },
}

async function acceptLifecycleRequest(event: MessageEvent<OfflineEnvelope>): Promise<void> {
  if (!offlineSessionId() || event.source !== window.parent || event.origin !== location.origin) return
  const message = event.data
  if (message?.protocol !== OFFLINE_PROTOCOL || message.contractVersion !== CONTRACT_VERSION) return
  if (message.sessionId !== offlineSessionId() || !message.requestId || !lifecycleAdapter) return
  if (message.type === 'lifecycle.pause.request') {
    await lifecycleAdapter.pause()
    report('lifecycle.pause.ack', lifecycleAdapter.getState(), message.requestId)
  } else if (message.type === 'lifecycle.resume.request') {
    await lifecycleAdapter.resume()
    report('lifecycle.resume.ack', lifecycleAdapter.getState(), message.requestId)
  }
}

async function validateStorageRoundTrip(): Promise<void> {
  const platform = platformClient()
  if (!platform.saveCloudData || !platform.getCloudData) return
  const key = `__zaohua_validation__:${offlineSessionId() || 'online'}`
  const expected = { contractVersion: CONTRACT_VERSION, nonce: `${Date.now()}-${Math.random()}` }
  await storage.set(key, expected)
  const actual = await storage.get(key)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Storage round trip returned a different value')
  report('storage.roundtrip.succeeded')
}

function normalizeCapabilities(input: readonly Capability[]): Capability[] {
  if (!Array.isArray(input)) throw new Error('initialize() requires a capabilities array')
  const unknown = input.filter((capability) => !CAPABILITIES.includes(capability))
  if (unknown.length > 0) throw new Error(`Unsupported capabilities: ${unknown.join(', ')}`)
  const normalized = [...new Set(input)]
  const missingRequired = REQUIRED_CAPABILITIES.filter((capability) => !normalized.includes(capability))
  if (missingRequired.length > 0) throw new Error(`Missing required capabilities: ${missingRequired.join(', ')}`)
  return normalized
}

function normalizeUser(value: Record<string, unknown> | null | undefined): User {
  const id = firstString(value?.userId, value?.id, value?.openid, 'anonymous')
  const name = firstString(value?.nickname, value?.name, 'Anonymous Player')
  const avatar = firstString(value?.avatar)
  return { id, name, ...(avatar ? { avatar } : {}) }
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? ''
}

export function createStandalonePlatformClient(): PlatformClientGlobal {
  const store = new Map<string, unknown>()
  const pauseListeners = new Set<() => void>()
  const resumeListeners = new Set<() => void>()

  const game = {
    loading(detail?: unknown): void {
      report('game.loading', detail)
      if (typeof window !== 'undefined') {
        try { window.dispatchEvent(new CustomEvent('platform:game-loading', { detail })) } catch {}
      }
    },
    loaded(): void {
      report('game.loaded')
      if (typeof window !== 'undefined') {
        try { window.dispatchEvent(new CustomEvent('platform:game-loaded')) } catch {}
      }
    },
    onPause(handler: () => void): () => void {
      pauseListeners.add(handler)
      return () => { pauseListeners.delete(handler) }
    },
    onResume(handler: () => void): () => void {
      resumeListeners.add(handler)
      return () => { resumeListeners.delete(handler) }
    },
  }

  const getUserInfo = async (): Promise<Record<string, unknown>> => {
    const isOffline = Boolean(offlineSessionId())
    return {
      userId: isOffline ? 'offline-user' : 'anonymous',
      nickname: isOffline ? 'Offline Player' : 'Anonymous Player',
    }
  }

  const getCloudData = async (key: string): Promise<unknown> => {
    if (typeof localStorage !== 'undefined') {
      try {
        const item = localStorage.getItem(`__vag_cloud_data_${key}`)
        if (item !== null) return JSON.parse(item)
      } catch {}
    }
    return store.has(key) ? store.get(key) : null
  }

  const saveCloudData = async (key: string, value: unknown): Promise<void> => {
    store.set(key, value)
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`__vag_cloud_data_${key}`, JSON.stringify(value))
      } catch {}
    }
  }

  const rooms = createStandaloneRoomDirectory()

  const bridge = {
    ping: () => Promise.resolve({ ok: true }),
  }

  const studio = {
    ping: () => Promise.resolve({ ok: true }),
    log: (level: StudioLogLevel, message: string, detail?: unknown) => {
      if (typeof console !== 'undefined' && console[level]) {
        console[level](message, detail)
      }
    },
  }

  return {
    bridge,
    game,
    getUserInfo,
    getCloudData,
    saveCloudData,
    room: createStandaloneRoomConnection,
    rooms,
    studio,
  }
}

function platformClient(): PlatformClientGlobal {
  return window.PlatformClient ?? window.FXclient ?? {}
}

function requireCapability(capability: Capability): void {
  if (!initialized) throw new Error('Call initialize() before using vag-platform-sdk')
  if (!declaredCapabilities.has(capability)) throw new Error(`Capability was not declared: ${capability}`)
}

function offlineSessionId(): string {
  return window.__ZAOHUA_OFFLINE_SESSION__ ?? new URLSearchParams(location.search).get('zaohuaSession') ?? ''
}

function report(type: string, payload?: unknown, requestId?: string): void {
  const sessionId = offlineSessionId()
  if (!sessionId || window.parent === window) return
  const envelope: OfflineEnvelope = {
    protocol: OFFLINE_PROTOCOL,
    contractVersion: CONTRACT_VERSION,
    sessionId,
    type,
    ...(requestId ? { requestId } : {}),
    ...(payload === undefined ? {} : { payload }),
  }
  window.parent.postMessage(envelope, location.origin)
}

function isEmbeddedGame(): boolean {
  return window.self !== window.top || typeof window.KubeeGameBridge?.postMessage === 'function'
}

function reportFpsStats(stats: FpsStats): void {
  const message = JSON.stringify({ type: 'VAG_FPS_STATS', payload: stats })
  if (typeof window.KubeeGameBridge?.postMessage === 'function') {
    try {
      window.KubeeGameBridge.postMessage(message)
    } catch (error) {
      console.warn('KubeeGameBridge.postMessage failed', error)
    }
    return
  }
  if (window.self === window.top) return
  window.parent.postMessage({ type: 'VAG_FPS_STATS', payload: stats }, '*')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
