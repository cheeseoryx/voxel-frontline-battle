import {
  BASIN_FLAGS,
  BLEED_INTERVAL,
  CAPTURE_SEC,
  FLAG_RADIUS,
  MOVE_BUDGET_MPS,
  ROUND_SEC,
  TICKETS_START,
  WORLD_SIZE,
  type ClientAction,
  type FlagState,
  type MatchEvent,
  type MatchState,
  type PlayerPose,
  type WireMessage,
} from '../../shared/protocol'
import { resolveMode, specFor, type ModeId } from '../../shared/modes'
import {
  canSwitchTeam,
  cloneRoster,
  emptyRoster,
  HUMAN_CAP,
  HUMAN_PER_TEAM,
  pickJoinTeam,
  rosterAdd,
  rosterCounts,
  rosterRemove,
  rosterTeamOf,
  type Roster,
  type TeamId,
} from '../../shared/roster'

type SeatPlayer = { id: string; name: string; isHost?: boolean }

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function makeFlags(): FlagState[] {
  return BASIN_FLAGS.map((flag) => ({
    letter: flag.letter,
    owner: 'neutral' as const,
    phase: 'neutral',
    attackingTeam: null,
    progress: 0,
    capture: 0,
    contested: false,
    allyN: 0,
    enemyN: 0,
    x: flag.nx * WORLD_SIZE,
    y: 8,
    z: flag.nz * WORLD_SIZE,
  }))
}

function blankPlayer(player: SeatPlayer, team: TeamId): PlayerPose {
  const south = team === 'ally'
  return {
    id: player.id,
    name: player.name || '指挥官',
    team,
    x: south ? 410 : 532,
    y: 8,
    z: south ? 82 : 942,
    yaw: south ? 0 : Math.PI,
    hp: 100,
    alive: true,
    crouch: false,
    classId: 'assault',
    stealth: false,
    vehicleId: null,
    vehicleSeat: null,
    vehicleRole: null,
    loadout: null,
  }
}

export class MatchKernel {
  private readonly players = new Map<string, PlayerPose>()
  private roster: Roster = emptyRoster()
  private events: MatchEvent[] = []
  private eventId = 0
  private lastEventTrim = 0
  private matchId = ''
  private seed = 0
  private mode: ModeId = 'conquest'
  private map = specFor('conquest').map
  private quick = false
  private phase: MatchState['phase'] = 'play'
  private tickets = { ally: TICKETS_START, enemy: TICKETS_START }
  private ticketsMax = TICKETS_START
  private elapsed = 0
  private flags = makeFlags()
  private winner: TeamId | null = null
  private endReason = ''
  private bleedAcc = 0
  private lastPoseAt = new Map<string, number>()
  private hostId = ''
  private seq = 0
  private configured = false

  constructor(seats: SeatPlayer[]) {
    this.matchId = 'cq-' + Date.now().toString(36)
    this.seed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0
    this.hostId = seats[0]?.id || ''
    for (const seat of seats) this.ensurePlayer(seat)
  }

  configure(input: { mode?: unknown; seed?: unknown; quick?: unknown; map?: unknown }): void {
    this.mode = resolveMode(input.mode)
    const spec = specFor(this.mode)
    this.map = typeof input.map === 'string' && input.map ? input.map : spec.map
    if (typeof input.seed === 'number' && Number.isFinite(input.seed)) this.seed = input.seed >>> 0
    this.quick = !!input.quick
    this.configured = true
    this.push(this.startMessage())
  }

  ensurePlayer(player: SeatPlayer): PlayerPose {
    const existing = this.players.get(player.id)
    if (existing) {
      if (player.name) existing.name = player.name
      return existing
    }
    const cap = specFor(this.mode).maxPlayers
    const perTeam = cap <= 2 ? 1 : HUMAN_PER_TEAM
    const team = pickJoinTeam(rosterCounts(this.roster), cap, perTeam) || 'ally'
    this.roster = rosterAdd(this.roster, player.id, team)
    const pose = blankPlayer(player, team)
    this.players.set(player.id, pose)
    this.push({
      type: 'roster',
      roster: cloneRoster(this.roster),
      playerId: player.id,
      team,
    })
    return pose
  }

  reconnectPlayer(id: string): void {
    const player = this.players.get(id)
    if (!player) return
    player.alive = true
  }

  removePlayer(playerId: string): void {
    this.players.delete(playerId)
    this.lastPoseAt.delete(playerId)
    this.roster = rosterRemove(this.roster, playerId)
    this.push({ type: 'leave', fromId: playerId, playerId })
  }

  start(): void {
    this.phase = 'play'
  }

  stop(): void {
    this.phase = 'finished'
  }

  applyAction(playerId: string, input: ClientAction | WireMessage | null | undefined): void {
    if (!input || typeof input !== 'object') return
    const player = this.players.get(playerId)
    if (!player && (input as ClientAction).type !== 'configure') return
    if ((input as ClientAction).type === 'configure') {
      this.configure(input as { mode?: unknown; seed?: unknown; quick?: unknown; map?: unknown })
      this.push(this.startMessage())
      return
    }
    const wire = (input as ClientAction).type === 'wire'
      ? (input as Extract<ClientAction, { type: 'wire' }>).message
      : (input as WireMessage)
    if (!wire || typeof wire.type !== 'string') return
    wire.fromId = playerId
    this.ingest(playerId, wire)
  }

  tick(dt = 0.05): boolean {
    if (this.phase !== 'play' || this.winner) return !!this.winner
    this.elapsed += dt
    this.seq += 1
    if (this.mode === 'conquest') this.tickConquest(dt)
    if (this.elapsed >= ROUND_SEC && !this.winner) {
      const ally = this.tickets.ally
      const enemy = this.tickets.enemy
      this.finish(ally === enemy ? 'ally' : ally > enemy ? 'ally' : 'enemy', 'timeout')
    }
    if (this.events.length > 64) this.events = this.events.slice(-48)
    return !!this.winner
  }

  getPlayerCount(): number {
    return this.players.size
  }

  getState(): MatchState {
    return {
      matchId: this.matchId,
      seq: Math.max(1, this.seq),
      seed: this.seed,
      mode: this.mode,
      map: this.map,
      phase: this.phase,
      quick: this.quick,
      roster: cloneRoster(this.roster),
      players: Object.fromEntries(this.players),
      tickets: { ...this.tickets },
      ticketsMax: this.ticketsMax,
      elapsed: this.elapsed,
      roundSec: ROUND_SEC,
      flags: this.flags.map((flag) => ({ ...flag })),
      winner: this.winner,
      endReason: this.endReason,
      events: this.events.slice(this.lastEventTrim),
      start: this.configured ? this.startMessage() : { type: 'pending' },
    }
  }

  getDelta(): MatchState {
    return this.getState()
  }

  getResult(): { winner: TeamId | null; reason: string; tickets: { ally: number; enemy: number } } {
    return { winner: this.winner, reason: this.endReason, tickets: { ...this.tickets } }
  }

  markEventsFlushed(): void {
    this.lastEventTrim = this.events.length
  }

  private startMessage(): WireMessage {
    const hostTeam = rosterTeamOf(this.roster, this.hostId) || 'ally'
    return {
      type: 'start',
      seed: this.seed,
      hostTeam,
      guestTeam: hostTeam === 'ally' ? 'enemy' : 'ally',
      roster: cloneRoster(this.roster),
      matchMode: this.mode,
      quick: this.quick,
      matchId: this.matchId,
      map: this.map,
    }
  }

  private ingest(playerId: string, wire: WireMessage): void {
    const player = this.players.get(playerId)
    if (!player) return
    switch (wire.type) {
      case 'hello':
      case 'joinRequest':
        this.push({
          type: 'roster',
          roster: cloneRoster(this.roster),
          playerId,
          team: player.team,
        })
        this.push(this.startMessage())
        return
      case 'state':
        this.applyPose(player, wire)
        return
      case 'damage':
        this.applyDamage(playerId, wire)
        return
      case 'teamSwitchRequest':
        this.applyTeamSwitch(playerId, wire.team as TeamId)
        return
      case 'spawnReady':
      case 'ready':
      case 'enter':
      case 'quickDeployed':
      case 'build':
      case 'break':
      case 'hud':
      case 'playerDead':
      case 'playerCasualty':
      case 'playerRespawn':
      case 'coreDmg':
      case 'conquest-command':
        this.push(wire)
        return
      case 'winner':
        if (typeof wire.winnerTeam === 'string') {
          this.finish(wire.winnerTeam as TeamId, String(wire.reason || 'match'))
        }
        return
      case 'leave':
        this.removePlayer(playerId)
        return
      default:
        this.push(wire)
    }
  }

  private applyPose(player: PlayerPose, wire: WireMessage): void {
    const now = Date.now()
    const prev = this.lastPoseAt.get(player.id) || now
    const dt = clamp((now - prev) / 1000, 0.016, 0.25)
    this.lastPoseAt.set(player.id, now)
    const nx = finite(wire.x, player.x)
    const ny = finite(wire.y, player.y)
    const nz = finite(wire.z, player.z)
    const dist = Math.hypot(nx - player.x, nz - player.z)
    const maxDist = MOVE_BUDGET_MPS * dt * 1.35
    if (dist > maxDist && dist > 2) {
      const t = maxDist / dist
      player.x += (nx - player.x) * t
      player.z += (nz - player.z) * t
    } else {
      player.x = nx
      player.z = nz
    }
    player.y = ny
    player.yaw = finite(wire.yaw, player.yaw)
    if (typeof wire.hp === 'number') player.hp = clamp(wire.hp, 0, 100)
    player.alive = wire.alive !== false && player.hp > 0
    player.crouch = !!wire.crouch
    if (typeof wire.classId === 'string' && wire.classId) player.classId = wire.classId
    if (wire.team === 'ally' || wire.team === 'enemy') player.team = wire.team
    player.stealth = !!wire.stealth
    player.vehicleId = typeof wire.vehicleId === 'string' ? wire.vehicleId : null
    player.vehicleSeat = typeof wire.vehicleSeat === 'number' ? wire.vehicleSeat : null
    player.vehicleRole = typeof wire.vehicleRole === 'string' ? wire.vehicleRole : null
    this.push({
      type: 'state',
      fromId: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      hp: player.hp,
      alive: player.alive,
      crouch: player.crouch,
      classId: player.classId,
      team: player.team,
      stealth: player.stealth,
      vehicleId: player.vehicleId,
      vehicleSeat: player.vehicleSeat,
      vehicleRole: player.vehicleRole,
      vehicleThrottle: wire.vehicleThrottle || 0,
      vehicleSteer: wire.vehicleSteer || 0,
      vehicleBrake: wire.vehicleBrake || 0,
      vehicleBoost: !!wire.vehicleBoost,
      vehicleSlow: !!wire.vehicleSlow,
      vehicleTurretLocked: !!wire.vehicleTurretLocked,
      vehicleAimYaw: wire.vehicleAimYaw || 0,
      vehicleAimPitch: wire.vehicleAimPitch || 0,
      vehicleWeaponIndex: wire.vehicleWeaponIndex || 0,
      vehicleFire: !!wire.vehicleFire,
      weaponFireSeq: wire.weaponFireSeq || 0,
      weaponId: wire.weaponId || null,
    })
  }

  private applyDamage(fromId: string, wire: WireMessage): void {
    const amount = Math.max(0, Math.round(finite(wire.dmg, 0)))
    if (!amount) return
    const targetId = typeof wire.targetId === 'string' && wire.targetId ? wire.targetId : this.pickOpponent(fromId)
    if (!targetId || targetId === fromId) return
    const target = this.players.get(targetId)
    if (!target || !target.alive) return
    target.hp = Math.max(0, target.hp - amount)
    if (target.hp <= 0) target.alive = false
    this.push({
      type: 'damage',
      fromId,
      targetId,
      dmg: amount,
      id: wire.id || fromId + '_' + Date.now(),
      hp: target.hp,
      alive: target.alive,
    })
  }

  private applyTeamSwitch(playerId: string, team: TeamId): void {
    if (team !== 'ally' && team !== 'enemy') return
    const player = this.players.get(playerId)
    if (!player) return
    const cap = specFor(this.mode).maxPlayers
    const perTeam = cap <= 2 ? 1 : HUMAN_PER_TEAM
    if (!canSwitchTeam(player.team, team, rosterCounts(this.roster), perTeam)) return
    this.roster = rosterAdd(this.roster, playerId, team)
    player.team = team
    this.push({ type: 'teamSwitch', playerId, team, roster: cloneRoster(this.roster) })
  }

  private tickConquest(dt: number): void {
    for (const flag of this.flags) {
      let allyN = 0
      let enemyN = 0
      for (const player of this.players.values()) {
        if (!player.alive) continue
        if (Math.hypot(player.x - flag.x, player.z - flag.z) > FLAG_RADIUS) continue
        if (player.team === 'ally') allyN += 1
        else enemyN += 1
      }
      flag.allyN = allyN
      flag.enemyN = enemyN
      flag.contested = allyN > 0 && enemyN > 0
      const rate = dt / CAPTURE_SEC
      if (flag.contested) continue
      if (allyN > 0) {
        flag.capture = clamp(flag.capture + rate, -1, 1)
        flag.attackingTeam = 'ally'
        flag.progress = (flag.capture + 1) / 2
      } else if (enemyN > 0) {
        flag.capture = clamp(flag.capture - rate, -1, 1)
        flag.attackingTeam = 'enemy'
        flag.progress = (flag.capture + 1) / 2
      } else {
        flag.attackingTeam = null
      }
      if (flag.capture >= 1) {
        flag.owner = 'ally'
        flag.phase = 'held'
        flag.progress = 1
      } else if (flag.capture <= -1) {
        flag.owner = 'enemy'
        flag.phase = 'held'
        flag.progress = 1
      } else if (flag.capture === 0) {
        flag.owner = 'neutral'
        flag.phase = 'neutral'
        flag.progress = 0
      } else {
        flag.phase = 'capturing'
      }
    }
    this.bleedAcc += dt
    if (this.bleedAcc >= BLEED_INTERVAL) {
      this.bleedAcc = 0
      let allyFlags = 0
      let enemyFlags = 0
      for (const flag of this.flags) {
        if (flag.owner === 'ally') allyFlags += 1
        if (flag.owner === 'enemy') enemyFlags += 1
      }
      if (allyFlags > enemyFlags) this.tickets.enemy = Math.max(0, this.tickets.enemy - (allyFlags - enemyFlags))
      if (enemyFlags > allyFlags) this.tickets.ally = Math.max(0, this.tickets.ally - (enemyFlags - allyFlags))
      if (this.tickets.ally <= 0) this.finish('enemy', 'tickets')
      else if (this.tickets.enemy <= 0) this.finish('ally', 'tickets')
    }
  }

  private finish(winner: TeamId, reason: string): void {
    if (this.winner) return
    this.winner = winner
    this.endReason = reason
    this.phase = 'finished'
    this.push({ type: 'winner', winnerTeam: winner, reason })
  }

  private pickOpponent(fromId: string): string | null {
    const from = this.players.get(fromId)
    if (!from) return null
    for (const player of this.players.values()) {
      if (player.id !== fromId && player.team !== from.team && player.alive) return player.id
    }
    return null
  }

  private push(message: WireMessage): void {
    this.eventId += 1
    this.events.push({ id: this.eventId, message })
    if (this.events.length > 128) this.events = this.events.slice(-96)
  }
}

void HUMAN_CAP
