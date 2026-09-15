export type TeamId = 'ally' | 'enemy'

export type Roster = {
  ally: string[]
  enemy: string[]
}

export const HUMAN_CAP = 16
export const HUMAN_PER_TEAM = 8

export function emptyRoster(): Roster {
  return { ally: [], enemy: [] }
}

export function cloneRoster(roster?: Roster | null): Roster {
  return {
    ally: [...((roster && roster.ally) || [])],
    enemy: [...((roster && roster.enemy) || [])],
  }
}

export function rosterCounts(roster?: Roster | null): { ally: number; enemy: number } {
  return {
    ally: ((roster && roster.ally) || []).length,
    enemy: ((roster && roster.enemy) || []).length,
  }
}

export function rosterTeamOf(roster: Roster | null | undefined, id: string | null | undefined): TeamId | null {
  if (!roster || id == null) return null
  const sid = String(id)
  if ((roster.ally || []).some((item) => String(item) === sid)) return 'ally'
  if ((roster.enemy || []).some((item) => String(item) === sid)) return 'enemy'
  return null
}

export function rosterAdd(roster: Roster | null | undefined, id: string, team: TeamId): Roster {
  const next = cloneRoster(roster)
  const sid = String(id)
  next.ally = next.ally.filter((item) => String(item) !== sid)
  next.enemy = next.enemy.filter((item) => String(item) !== sid)
  if (team === 'enemy') next.enemy.push(sid)
  else next.ally.push(sid)
  return next
}

export function rosterRemove(roster: Roster | null | undefined, id: string): Roster {
  const sid = String(id)
  return {
    ally: ((roster && roster.ally) || []).filter((item) => String(item) !== sid),
    enemy: ((roster && roster.enemy) || []).filter((item) => String(item) !== sid),
  }
}

export function pickJoinTeam(counts: { ally: number; enemy: number }, cap = HUMAN_CAP, perTeam = HUMAN_PER_TEAM): TeamId | null {
  const hb = counts.ally || 0
  const hr = counts.enemy || 0
  if (hb + hr >= cap) return null
  if (hb < hr && hb < perTeam) return 'ally'
  if (hr < hb && hr < perTeam) return 'enemy'
  if (hb === hr) {
    if (hb >= perTeam) return null
    return Math.random() < 0.5 ? 'enemy' : 'ally'
  }
  if (hb < perTeam) return 'ally'
  if (hr < perTeam) return 'enemy'
  return null
}

export function canSwitchTeam(from: TeamId | null, to: TeamId | null, counts: { ally: number; enemy: number }, perTeam = HUMAN_PER_TEAM): boolean {
  if (!to || from === to) return false
  const dest = to === 'enemy' ? counts.enemy || 0 : counts.ally || 0
  return dest < perTeam
}
