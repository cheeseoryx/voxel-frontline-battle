import type { MeshLodLevel } from '@forgeax/engine-types';

export interface ProjectedHeightInput {
  readonly radius: number;
  readonly depth: number;
  readonly projection: 'perspective' | 'orthographic';
  readonly fov?: number;
  readonly orthoHeight?: number;
}

export interface LodSelectorInput {
  /** Lower-detail levels in ascending detail order; LOD0 is implicit. */
  readonly levels: readonly Pick<MeshLodLevel, 'screenCoverage'>[];
  readonly projectedHeight: number;
  readonly previousLevel: number;
  readonly hysteresis: number;
  /** Index zero is the root and must remain the safe fallback. */
  readonly ready: readonly boolean[];
  readonly historyValid: boolean;
}

export interface LodSelection {
  readonly level: number;
  readonly confidence: number;
}

export function projectedHeight(input: ProjectedHeightInput): number {
  if (!Number.isFinite(input.radius) || input.radius <= 0 || !Number.isFinite(input.depth)) {
    return Number.NaN;
  }
  if (input.projection === 'perspective') {
    if (!Number.isFinite(input.fov) || (input.fov ?? 0) <= 0 || input.depth <= 0) return Number.NaN;
    return (2 * input.radius) / (input.depth * Math.tan((input.fov ?? 0) / 2));
  }
  if (!Number.isFinite(input.orthoHeight) || (input.orthoHeight ?? 0) <= 0) return Number.NaN;
  return (2 * input.radius) / (input.orthoHeight ?? 0);
}

function rawLevel(levels: readonly Pick<MeshLodLevel, 'screenCoverage'>[], height: number): number {
  for (let index = 0; index < levels.length; index += 1) {
    const threshold = levels[index]?.screenCoverage;
    if (threshold !== undefined && height >= threshold) return index;
  }
  return levels.length;
}

function hysteresisLevel(input: LodSelectorInput, raw: number): number {
  if (!input.historyValid || input.previousLevel < 0 || input.previousLevel > input.levels.length) {
    return raw;
  }
  const previous = input.previousLevel;
  if (raw === previous) return previous;
  const clampedHysteresis = Math.min(Math.max(input.hysteresis, 0), 0.99);
  // A downgrade crosses the next lower-detail threshold; an upgrade crosses
  // the threshold that introduced the current level. These are adjacent
  // boundaries even when a frame jumps over several levels.
  const thresholdIndex =
    raw > previous
      ? Math.min(previous, input.levels.length - 1)
      : Math.min(previous, input.levels.length) - 1;
  const threshold =
    thresholdIndex < 0
      ? input.levels[0]?.screenCoverage
      : input.levels[thresholdIndex]?.screenCoverage;
  if (threshold === undefined || !Number.isFinite(threshold)) return raw;
  const height = input.projectedHeight;
  if (raw > previous && height >= threshold * (1 - clampedHysteresis)) return previous;
  if (raw < previous && height < threshold * (1 + clampedHysteresis)) return previous;
  return raw;
}

export function selectLod(input: LodSelectorInput): LodSelection {
  const root = 0;
  if (!Number.isFinite(input.projectedHeight) || input.projectedHeight <= 0) {
    return { level: root, confidence: 1 };
  }
  const raw = rawLevel(input.levels, input.projectedHeight);
  const selected = Math.max(root, Math.min(input.levels.length, hysteresisLevel(input, raw)));
  if (input.ready[selected] === true) return { level: selected, confidence: 1 };
  for (let level = selected - 1; level >= root; level -= 1) {
    if (input.ready[level] === true) return { level, confidence: 1 };
  }
  return { level: root, confidence: 1 };
}
