import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  type GpuDrivenDrawRange,
  type PreparedGpuDrivenDraw,
  type PrepareGpuDrivenDrawInput,
  prepareGpuDrivenDraw,
} from '../gpu-driven/prepared-draw';
import type { MaterialSnapshot } from '../render-system-extract';

export {
  GpuDrivenPreparationError,
  type GpuDrivenPreparationErrorCode,
  type GpuDrivenPreparationErrorDetail,
  type GpuDrivenPreparationReason,
} from '../errors/gpu-driven';
export {
  type GpuDrivenDrawRange,
  type GpuDrivenGeometryReceipt,
  type GpuDrivenSkinReceipt,
  type PreparedGpuDrivenDraw,
  type PrepareGpuDrivenDrawInput,
  prepareGpuDrivenDraw,
} from '../gpu-driven/prepared-draw';

export interface GpuDrivenDrawSnapshot {
  readonly kind: GpuDrivenDrawRange['kind'];
  readonly first: GpuDrivenDrawRange['first'];
  readonly count: GpuDrivenDrawRange['count'];
  readonly baseVertex: GpuDrivenDrawRange['baseVertex'];
  readonly materialSlot: number;
  readonly topology: GpuDrivenDrawRange['topology'];
  readonly pipelineClass: string;
  readonly materialResourceClass: string;
  /** Producer-owned prepared ABI facts used by the PBR GPU lane. */
  readonly prepared?: PreparedGpuDrivenDraw;
}

/**
 * Resolves prepared facts once at extract time; record never re-reads assets.
 * The resolver surfaces UV, reflection, vertex, alpha, resource, and
 * generation failures as GpuDrivenPreparationError before recording.
 */
export function resolvePreparedGpuDrivenDraw(input: PrepareGpuDrivenDrawInput):
  | { readonly ok: true; readonly value: PreparedGpuDrivenDraw }
  | {
      readonly ok: false;
      readonly error: import('../errors/gpu-driven').GpuDrivenPreparationError;
    } {
  return prepareGpuDrivenDraw(input);
}

/** Keeps the artifact type visible at this owner boundary for contract checks. */
export type PreparedGpuDrivenArtifact = MaterialShaderArtifact;

/**
 * Derives the resource identity consumed by the existing GPU-driven batch
 * owner. The extract stage is the only place that resolves material values;
 * this helper keeps the batch adapter from re-reading assets later.
 */
export function gpuDrivenMaterialResourceClass(material: MaterialSnapshot): string {
  const textures = [...(material.textureHandles?.entries() ?? [])]
    .map(([name, handle]) => [name, Number(handle)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const samplers = [...(material.samplerHandles?.entries() ?? [])]
    .map(([name, handle]) => [name, Number(handle)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    textures,
    samplers,
    video: [...(material.videoTextureFields?.keys() ?? [])].sort(),
  });
}

/**
 * Projects already-resolved mesh facts into the existing GPU-driven draw
 * snapshot. No World or AssetRegistry access is permitted at this boundary.
 */
export function buildGpuDrivenDraws(input: {
  readonly submeshes: readonly MeshAsset['submeshes'][number][];
  readonly indexed: boolean;
  readonly materials: readonly MaterialSnapshot[];
  readonly fallbackMaterial: MaterialSnapshot;
  readonly prepare?: (
    draw: GpuDrivenDrawSnapshot,
    material: MaterialSnapshot,
  ) => PreparedGpuDrivenDraw | undefined;
}): GpuDrivenDrawSnapshot[] {
  let nonIndexedFirst = 0;
  return input.submeshes.flatMap((submesh) => {
    const drawMaterial = input.materials[submesh.materialSlot] ?? input.fallbackMaterial;
    const first = input.indexed ? submesh.indexOffset : nonIndexedFirst;
    nonIndexedFirst += submesh.vertexCount;
    if (drawMaterial.transparent === true) return [];
    const draw: GpuDrivenDrawSnapshot = {
      kind: input.indexed ? ('indexed' as const) : ('non-indexed' as const),
      first,
      count: input.indexed ? submesh.indexCount : submesh.vertexCount,
      baseVertex: 0,
      materialSlot: submesh.materialSlot,
      topology: submesh.topology,
      pipelineClass: `${drawMaterial.materialShaderId ?? 'forgeax::default-unlit'}|${submesh.topology}|${JSON.stringify(drawMaterial.renderState ?? null)}`,
      materialResourceClass: gpuDrivenMaterialResourceClass(drawMaterial),
    };
    const prepared = input.prepare?.(draw, drawMaterial);
    return [prepared === undefined ? draw : { ...draw, prepared }];
  });
}
