/** Mode catalog shared by lobby mapping and the dedicated server. */

export type ModeId = 'conquest' | 'tdm' | 'demo' | 'ffa' | 'gungame' | 'core'

export type ModeSpec = {
  id: ModeId
  label: string
  map: string
  maxPlayers: number
  sizeLabel: string
}

export const MODE_SPECS: Record<ModeId, ModeSpec> = {
  conquest: {
    id: 'conquest',
    label: '大型战争',
    map: '荒盆',
    maxPlayers: 16,
    sizeLabel: '8 v 8',
  },
  tdm: {
    id: 'tdm',
    label: '团队死斗',
    map: '死斗街区',
    maxPlayers: 2,
    sizeLabel: '2 真人席位 + AI',
  },
  demo: {
    id: 'demo',
    label: '爆破模式',
    map: '爆破街区',
    maxPlayers: 2,
    sizeLabel: '2 真人席位 + AI',
  },
  ffa: {
    id: 'ffa',
    label: '自由混战',
    map: '混战街区',
    maxPlayers: 2,
    sizeLabel: '2 真人席位 + AI',
  },
  gungame: {
    id: 'gungame',
    label: '枪械模式',
    map: '混战街区',
    maxPlayers: 2,
    sizeLabel: '2 真人席位 + AI',
  },
  core: {
    id: 'core',
    label: '核心攻防',
    map: '核心街区',
    maxPlayers: 2,
    sizeLabel: '2 真人席位 + AI',
  },
}

export function resolveMode(value: unknown): ModeId {
  const id = String(value || '')
  if (id in MODE_SPECS) return id as ModeId
  return 'conquest'
}

export function specFor(mode: unknown): ModeSpec {
  return MODE_SPECS[resolveMode(mode)]
}
