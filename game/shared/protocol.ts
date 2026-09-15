import type { ModeId } from './modes'
import type { Roster, TeamId } from './roster'

export type WireMessage = {
  type: string
  fromId?: string
  [key: string]: unknown
}

export type PlayerPose = {
  id: string
  name: string
  team: TeamId
  x: number
  y: number
  z: number
  yaw: number
  hp: number
  alive: boolean
  crouch: boolean
  classId: string
  stealth: boolean
  vehicleId: string | null
  vehicleSeat: number | null
  vehicleRole: string | null
  loadout: Record<string, unknown> | null
}

export type FlagState = {
  letter: string
  owner: 'ally' | 'enemy' | 'neutral'
  phase: string
  attackingTeam: TeamId | null
  progress: number
  capture: number
  contested: boolean
  allyN: number
  enemyN: number
  x: number
  y: number
  z: number
}

export type MatchEvent = {
  id: number
  message: WireMessage
}

export type MatchState = {
  matchId: string
  seq: number
  seed: number
  mode: ModeId
  map: string
  phase: 'waiting' | 'play' | 'finished'
  quick: boolean
  roster: Roster
  players: Record<string, PlayerPose>
  tickets: { ally: number; enemy: number }
  ticketsMax: number
  elapsed: number
  roundSec: number
  flags: FlagState[]
  winner: TeamId | null
  endReason: string
  events: MatchEvent[]
  start: WireMessage
}

export type ClientAction =
  | { type: 'configure'; mode?: ModeId; seed?: number; quick?: boolean; map?: string; name?: string }
  | { type: 'wire'; message: WireMessage }

export const TICKETS_START = 1000
export const ROUND_SEC = 45 * 60
export const FLAG_RADIUS = 30
export const CAPTURE_SEC = 10
export const BLEED_INTERVAL = 3
export const MOVE_BUDGET_MPS = 14
export const WORLD_SIZE = 1024

/** Official 荒盆 flag layout (normalized coords from island-conquest.js). */
export const BASIN_FLAGS: Array<{ letter: string; nx: number; nz: number }> = [
  { letter: 'A', nx: 0.518, nz: 0.212 },
  { letter: 'B', nx: 0.699, nz: 0.359 },
  { letter: 'C', nx: 0.625, nz: 0.547 },
  { letter: 'D', nx: 0.32, nz: 0.547 },
  { letter: 'E', nx: 0.55, nz: 0.781 },
  { letter: 'F', nx: 0.34, nz: 0.74 },
]
