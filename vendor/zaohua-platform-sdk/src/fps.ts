/* Generated from packages/vag-platform-sdk. Do not edit; run pnpm run build. */
export type FpsStats = {
  fps: number
  avg: number
  min: number
  max: number
  frameTimeMs: number
  timestamp: number
}

export type FpsOptions = {
  intervalMs?: number
  onStats?: (stats: FpsStats) => void
}

export type FpsController = {
  start(options?: FpsOptions): void
  stop(): void
  getStats(): FpsStats | null
}

const DEFAULT_INTERVAL_MS = 1000

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export function createFpsController(): FpsController {
  let running = false
  let rafId: number | null = null
  let intervalMs = DEFAULT_INTERVAL_MS
  let onStats: ((stats: FpsStats) => void) | null = null

  let lastFrameTs = 0
  let lastReportTs = 0
  let framesSinceReport = 0
  let lastFrameTimeMs = 0
  let minFps = Infinity
  let maxFps = 0
  let avgFps = 0
  let reportCount = 0
  let currentStats: FpsStats | null = null

  const resetCounters = (): void => {
    lastFrameTs = 0
    lastReportTs = 0
    framesSinceReport = 0
    lastFrameTimeMs = 0
    minFps = Infinity
    maxFps = 0
    avgFps = 0
    reportCount = 0
    currentStats = null
  }

  const tick = (timestamp: number): void => {
    if (!running) return

    if (!lastFrameTs) {
      lastFrameTs = timestamp
      lastReportTs = timestamp
    }

    lastFrameTimeMs = timestamp - lastFrameTs
    lastFrameTs = timestamp
    framesSinceReport += 1

    const elapsedMs = timestamp - lastReportTs
    if (elapsedMs >= intervalMs) {
      const fps = framesSinceReport / (elapsedMs / 1000)
      minFps = Math.min(minFps, fps)
      maxFps = Math.max(maxFps, fps)
      reportCount += 1
      avgFps += (fps - avgFps) / reportCount

      currentStats = {
        fps: round1(fps),
        avg: round1(avgFps),
        min: round1(minFps),
        max: round1(maxFps),
        frameTimeMs: round1(lastFrameTimeMs),
        timestamp: Date.now(),
      }

      onStats?.(currentStats)
      framesSinceReport = 0
      lastReportTs = timestamp
    }

    rafId = requestAnimationFrame(tick)
  }

  return {
    start(options: FpsOptions = {}): void {
      if (typeof options.intervalMs === 'number' && options.intervalMs > 0) {
        intervalMs = options.intervalMs
      }
      onStats = options.onStats ?? null

      if (running) resetCounters()
      else {
        running = true
        resetCounters()
        rafId = requestAnimationFrame(tick)
      }
    },

    stop(): void {
      running = false
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    },

    getStats(): FpsStats | null {
      return currentStats
    },
  }
}
