import type { PointShadowSnapshot } from './render-system-extract';

/**
 * Detached point-shadow budget facts from one completed extract/record frame.
 *
 * `requested` is the number of PointLight + PointLightShadow pairs. The
 * renderer owns the bounded cube-array atlas, so `admitted`, `shadowed`, and
 * `shadowAtlasOccupancy` are all derived from the layer sentinel emitted by
 * the same extract owner. No consumer needs to maintain a second budget
 * ledger.
 */
export interface PointShadowInspection {
  readonly status: 'inactive' | 'ready' | 'over-budget';
  readonly requested: number;
  readonly admitted: number;
  readonly shadowed: number;
  readonly shadowAtlasOccupancy: number;
  readonly shadowAtlasCapacity: number;
}

/** Project point-shadow snapshots to the public, JSON-safe inspection shape. */
export function inspectPointShadow(
  snapshots: readonly PointShadowSnapshot[],
  shadowAtlasCapacity: number,
): PointShadowInspection {
  const requested = snapshots.length;
  const admitted = snapshots.reduce(
    (count, snapshot) =>
      snapshot.shadowAtlasLayer >= 0 && snapshot.shadowAtlasLayer < shadowAtlasCapacity
        ? count + 1
        : count,
    0,
  );
  // Never publish a misleading `ready` state when any requested shadow owns
  // no atlas layer. The extract sentinel is the single admission projection;
  // a partial or all-sentinel frame is therefore a failed/over-budget
  // admission, not an active shadow path with incomplete output.
  const status =
    requested === 0
      ? ('inactive' as const)
      : requested > shadowAtlasCapacity || admitted !== requested
        ? ('over-budget' as const)
        : ('ready' as const);
  return Object.freeze({
    status,
    requested,
    admitted,
    // A point shadow only samples an atlas after it owns an atlas layer. Keep
    // these names explicit for AI diagnostics while deriving both from the
    // one layer projection above.
    shadowed: admitted,
    shadowAtlasOccupancy: admitted,
    shadowAtlasCapacity,
  });
}
