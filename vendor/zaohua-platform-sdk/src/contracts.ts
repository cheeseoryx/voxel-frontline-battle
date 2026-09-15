/* Generated from packages/vag-platform-sdk. Do not edit; run pnpm run build. */
export const OFFLINE_PROTOCOL = 'zaohua-offline-v2' as const
export const CONTRACT_VERSION = 2 as const

export const CAPABILITIES = [
  'game.loading',
  'game.lifecycle',
  'user.current',
  'storage',
  'studio.logging',
  'game.multiplayer',
] as const

export type Capability = typeof CAPABILITIES[number]
export const REQUIRED_CAPABILITIES = [] as const satisfies readonly Capability[]
export type ValidationState = 'pending' | 'passed' | 'failed'
export type ValidationTier = 'required' | 'optional'
export type UserVerdict = 'pending' | 'passed' | 'failed'
export type AutomationState = 'pending' | 'running' | 'passed' | 'failed'
export type SupportedPlatform = 'pc' | 'mobile' | 'both'

export type PlatformSupport = {
  supportPC: boolean
  supportMobile: boolean
}

export type ReplayDescriptor =
  | { type: 'viewport'; presetId: string; width: number; height: number }
  | { type: 'lifecycle'; action: 'pause' | 'resume' }
  | { type: 'reload' }

export type AutomationStatus = {
  state: AutomationState
  completed: number
  total: number
  activeCheck?: string
  startedAt?: string
  completedAt?: string
  failure?: {
    code: string
    message: string
    infrastructure?: boolean
    replay?: ReplayDescriptor
  }
}
export type PreviewAIMessageState = 'unread' | 'read' | 'ack' | 'mending' | 'fixed'

export type PreviewAIStatus = {
  state: 'idle' | PreviewAIMessageState
  batchId?: string
  message?: string
  updatedAt?: string
}

export type ValidationCheck = {
  id: string
  label: string
  tier: ValidationTier
  capability?: Capability
  manual: boolean
  dependencies: readonly string[]
  timeoutMs: number
  state: ValidationState
  message?: string
}

export type ExternalOptionalCapability = {
  id: string
  group: 'platform_extensions' | 'landing' | 'publishing'
  label: string
  purpose: string
  state: 'passed' | 'missing' | 'failed' | 'pending'
}

export type ValidationIssue = {
  code: string
  message: string
  tier?: ValidationTier
  detail?: unknown
  replay?: ReplayDescriptor
}

export type ValidationPlanMetadata = {
  id: string
  version: number
  platform: SupportedPlatform
  stepOrder: string[]
  digest: string
}

export type ValidationReport = {
  protocol: typeof OFFLINE_PROTOCOL
  contractVersion: typeof CONTRACT_VERSION
  sessionId: string
  capabilities: Capability[]
  state: ValidationState
  automation: AutomationStatus
  plan?: ValidationPlanMetadata
  /**
   * @deprecated Validation is fully automatic. This mirrors the aggregate
   * automatic result and no longer represents a user action.
   */
  userVerdict: UserVerdict
  checks: ValidationCheck[]
  issues: ValidationIssue[]
  adaptation: {
    score: number
    max: 100
    required_passed: boolean
    color: 'red' | 'yellow' | 'green'
    optionals: Array<{
      id: string
      group: 'platform_extensions' | 'landing' | 'publishing'
      label: string
      purpose: string
      points: number
      earned: number
      state: 'passed' | 'missing' | 'failed' | 'pending' | 'locked' | 'inapplicable'
    }>
  }
  updatedAt: string
}

export type OfflineEnvelope = {
  protocol: typeof OFFLINE_PROTOCOL
  contractVersion: typeof CONTRACT_VERSION
  sessionId: string
  type: string
  requestId?: string
  payload?: unknown
}

export type FpsStats = {
  fps: number
  avg: number
  min: number
  max: number
  frameTimeMs: number
  timestamp: number
}

export type TelemetryEventHandler = (event: OfflineEnvelope) => void
