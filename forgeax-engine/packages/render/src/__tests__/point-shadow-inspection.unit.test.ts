import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { inspectPointShadow } from '../point-shadow-inspection';
import type { PointShadowSnapshot } from '../render-system-extract';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';

function snapshots(...layers: number[]): PointShadowSnapshot[] {
  return layers.map((shadowAtlasLayer, entity) => ({
    entity,
    position: vec3.create(0, 0, 0),
    mapSize: 512,
    nearPlane: 0.1,
    farPlane: 25,
    shadowAtlasLayer,
    shadowMatrices: new Float32Array(96),
  }));
}

describe('point-shadow inspection', () => {
  it('derives requested, admitted, shadowed, and occupancy from one layer projection', () => {
    expect(inspectPointShadow(snapshots(0, 1, 2, 3, -1), SHADOW_ATLAS_DEFAULT_LAYERS)).toEqual({
      status: 'over-budget',
      requested: SHADOW_ATLAS_DEFAULT_LAYERS + 1,
      admitted: SHADOW_ATLAS_DEFAULT_LAYERS,
      shadowed: SHADOW_ATLAS_DEFAULT_LAYERS,
      shadowAtlasOccupancy: SHADOW_ATLAS_DEFAULT_LAYERS,
      shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
    });
  });

  it('reports disabled shadow production without inventing a fallback admission', () => {
    expect(inspectPointShadow([], SHADOW_ATLAS_DEFAULT_LAYERS)).toEqual({
      status: 'inactive',
      requested: 0,
      admitted: 0,
      shadowed: 0,
      shadowAtlasOccupancy: 0,
      shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
    });
  });

  it('treats an invalid layer as non-admitted and keeps the request visible', () => {
    expect(inspectPointShadow(snapshots(-1, 7), SHADOW_ATLAS_DEFAULT_LAYERS)).toMatchObject({
      status: 'over-budget',
      requested: 2,
      admitted: 0,
      shadowed: 0,
      shadowAtlasOccupancy: 0,
    });
  });

  it('does not call a partially admitted request ready', () => {
    expect(inspectPointShadow(snapshots(0, -1), SHADOW_ATLAS_DEFAULT_LAYERS)).toMatchObject({
      status: 'over-budget',
      requested: 2,
      admitted: 1,
      shadowed: 1,
    });
  });
});
