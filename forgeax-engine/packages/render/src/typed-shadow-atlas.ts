export interface DirectionalShadowAtlasGrid {
  readonly columns: 1 | 2;
  readonly rows: 1 | 2;
}

/**
 * The directional CSM atlas layout is one compact contract for raster writes
 * and shader reads: 1 -> 1x1, 2 -> 2x1, and 3/4 -> 2x2.
 */
export function resolveDirectionalShadowAtlasGrid(
  cascadeCount: number,
): DirectionalShadowAtlasGrid {
  const count = Math.max(1, Math.min(4, Math.round(cascadeCount)));
  if (count === 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  return { columns: 2, rows: 2 };
}
