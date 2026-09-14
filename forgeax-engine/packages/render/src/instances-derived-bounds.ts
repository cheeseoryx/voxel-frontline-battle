import { box3, type Mat4Like, mat4 } from '@forgeax/engine-math';

/**
 * Inputs owned by the render extract/persistent-scene boundary. Bounds are
 * deliberately derived here instead of being added to the author-facing
 * `Instances` component or written back to a Pack asset.
 */
export interface DerivedInstancesUnionBoundsInput {
  readonly meshAabb: ArrayLike<number> | undefined;
  readonly entityWorld: ArrayLike<number>;
  readonly transforms: ArrayLike<number> | undefined;
}

/**
 * Renderer-owned cache key. Each generation is supplied by the owner that can
 * observe that mutation: mesh/AABB publication, entity world transform, and
 * the packed instance matrix array respectively.
 */
export interface InstanceBoundsCacheKey {
  /** Optional scene/world scope for composite scenes; omitted for standalone tests. */
  readonly worldId?: number;
  readonly entityKey: number;
  readonly meshGeneration: number;
  readonly transformGeneration: number;
  readonly matrixGeneration: number;
}

export type InstanceBoundsCacheInput = InstanceBoundsCacheKey & DerivedInstancesUnionBoundsInput;

/**
 * Stable bitwise fingerprint for detached numeric facts used by the cache.
 * Float32 bits are hashed rather than decimal text so a real matrix/AABB
 * change invalidates the projection without keeping another mutable ledger.
 */
export function fingerprintNumericArray(values: ArrayLike<number>): number {
  let hash = 0x811c9dc5;
  const scalar = new Float32Array(1);
  const bits = new Uint32Array(scalar.buffer);
  for (let index = 0; index < values.length; index += 1) {
    scalar[0] = Number(values[index]);
    hash = Math.imul(hash ^ (bits[0] ?? 0), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function finiteAabb(aabb: ArrayLike<number> | undefined): aabb is ArrayLike<number> {
  if (aabb === undefined || aabb.length < 6) return false;
  const minX = aabb[0] as number;
  const minY = aabb[1] as number;
  const minZ = aabb[2] as number;
  const maxX = aabb[3] as number;
  const maxY = aabb[4] as number;
  const maxZ = aabb[5] as number;
  return (
    Number.isFinite(minX) &&
    Number.isFinite(minY) &&
    Number.isFinite(minZ) &&
    Number.isFinite(maxX) &&
    Number.isFinite(maxY) &&
    Number.isFinite(maxZ) &&
    minX <= maxX &&
    minY <= maxY &&
    minZ <= maxZ
  );
}

function finiteMatrix(matrix: ArrayLike<number>): matrix is Mat4Like {
  if (matrix.length < 16) return false;
  for (let index = 0; index < 16; index += 1) {
    if (!Number.isFinite(matrix[index] as number)) return false;
  }
  return true;
}

function includeBox(out: box3.Box3, candidate: box3.Box3Like): void {
  for (const x of [candidate[0] as number, candidate[3] as number]) {
    for (const y of [candidate[1] as number, candidate[4] as number]) {
      for (const z of [candidate[2] as number, candidate[5] as number]) {
        box3.expandByPoint(out, [x, y, z]);
      }
    }
  }
}

/**
 * Derive the world-space AABB enclosing every instance of a mesh.
 *
 * `undefined` is a conservative signal: the caller must skip CPU culling
 * when an input is missing, malformed, or empty. This prevents an empty
 * `Instances` row from becoming a synthetic identity draw/bounds candidate.
 */
export function deriveInstancesUnionBounds(
  input: DerivedInstancesUnionBoundsInput,
): Float32Array | undefined {
  const { meshAabb, entityWorld, transforms } = input;
  if (!finiteAabb(meshAabb) || !finiteMatrix(entityWorld) || transforms === undefined) {
    return undefined;
  }
  if (transforms.length === 0 || transforms.length % 16 !== 0) return undefined;

  const local = box3.create(
    meshAabb[0] as number,
    meshAabb[1] as number,
    meshAabb[2] as number,
    meshAabb[3] as number,
    meshAabb[4] as number,
    meshAabb[5] as number,
  );
  const union = box3.create();
  const composed = mat4.create();
  const transformed = box3.create();
  for (let offset = 0; offset < transforms.length; offset += 16) {
    const instance = new Float32Array(16);
    for (let lane = 0; lane < 16; lane += 1) {
      instance[lane] = transforms[offset + lane] as number;
    }
    if (!finiteMatrix(instance)) return undefined;
    mat4.multiply(composed, entityWorld, instance);
    box3.transformBox3(transformed, local, composed);
    if (!finiteAabb(transformed)) return undefined;
    includeBox(union, transformed);
  }
  return new Float32Array(union);
}

interface InstanceBoundsCacheEntry extends InstanceBoundsCacheKey {
  readonly bounds: Float32Array | undefined;
}

/**
 * Small renderer-owned per-entity cache. A changed generation replaces the
 * entry atomically; packed-id reuse is safe when its owner supplies a new
 * generation (the normal RenderScene slot generation contract).
 */
export class InstanceBoundsCache {
  private readonly entries = new Map<string, InstanceBoundsCacheEntry>();

  private key(input: Pick<InstanceBoundsCacheKey, 'worldId' | 'entityKey'>): string {
    return `${input.worldId === undefined ? '' : `${input.worldId}:`}${input.entityKey}`;
  }

  get(input: InstanceBoundsCacheInput): Float32Array | undefined {
    const previous = this.entries.get(this.key(input));
    if (
      previous !== undefined &&
      previous.meshGeneration === input.meshGeneration &&
      previous.transformGeneration === input.transformGeneration &&
      previous.matrixGeneration === input.matrixGeneration
    ) {
      return previous.bounds;
    }
    const bounds = deriveInstancesUnionBounds(input);
    this.entries.set(this.key(input), {
      ...(input.worldId === undefined ? {} : { worldId: input.worldId }),
      entityKey: input.entityKey,
      meshGeneration: input.meshGeneration,
      transformGeneration: input.transformGeneration,
      matrixGeneration: input.matrixGeneration,
      bounds,
    });
    return bounds;
  }

  invalidate(entityKey?: number, worldId?: number): void {
    if (entityKey === undefined) {
      this.entries.clear();
    } else {
      this.entries.delete(this.key({ entityKey, ...(worldId === undefined ? {} : { worldId }) }));
    }
  }
}
