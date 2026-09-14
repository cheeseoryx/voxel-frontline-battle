import type {
  MaterialShaderArtifact,
  MaterialShaderArtifactReceipt,
  MaterialShaderVertexInput,
} from '@forgeax/engine-shader';
import type { PrimitiveTopology } from '@forgeax/engine-types';
import {
  GpuDrivenPreparationError,
  type GpuDrivenPreparationErrorDetail,
} from '../errors/gpu-driven';
import type { RenderableSnapshot } from '../render-system-extract';

export interface GpuDrivenGeometryReceipt {
  readonly identity: string;
  readonly vertexInputs: readonly MaterialShaderVertexInput[];
  readonly topology: PrimitiveTopology;
  readonly indexed: boolean;
}

export interface GpuDrivenSkinReceipt {
  readonly identity: string;
  readonly generation: number;
  readonly group: number;
  readonly binding: number;
  readonly byteOffset: number;
}

export interface PreparedGpuDrivenDraw {
  readonly identity: {
    readonly material: string;
    readonly geometry: string;
    readonly deformation: 'rigid' | 'skin';
  };
  readonly receiptGeneration: number;
  readonly directEntry: string;
  readonly sceneIndexEntry: string;
  readonly materialRow: MaterialShaderArtifactReceipt['materialRow'];
  readonly resourceSlots: MaterialShaderArtifactReceipt['resourceSlots'];
  readonly uvSets: MaterialShaderArtifactReceipt['uvSets'];
  readonly vertexInputs: MaterialShaderArtifactReceipt['vertexInputs'];
  readonly alphaMask: MaterialShaderArtifactReceipt['alphaMask'];
  readonly skinPaletteAddress: MaterialShaderArtifactReceipt['skinPaletteAddress'];
  readonly topology: PrimitiveTopology;
  readonly indexed: boolean;
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
}

/** Exact extracted draw range consumed by the preparation owner. */
export interface GpuDrivenDrawRange {
  readonly kind: 'indexed' | 'non-indexed';
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
  readonly topology: PrimitiveTopology;
}

export interface PrepareGpuDrivenDrawInput {
  readonly snapshot: RenderableSnapshot;
  readonly artifact: MaterialShaderArtifact;
  readonly geometry: GpuDrivenGeometryReceipt;
  readonly generation: number;
  /** The submesh draw currently being prepared; never infer draw zero. */
  readonly draw: GpuDrivenDrawRange;
  readonly skinReceipt?: GpuDrivenSkinReceipt;
}

function failure(
  code: ConstructorParameters<typeof GpuDrivenPreparationError>[0],
  detail: GpuDrivenPreparationErrorDetail,
): { readonly ok: false; readonly error: GpuDrivenPreparationError } {
  return { ok: false, error: new GpuDrivenPreparationError(code, detail) };
}

function sameVertexInputs(
  expected: readonly MaterialShaderVertexInput[],
  actual: readonly MaterialShaderVertexInput[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every(
      (input, index) =>
        input.semantic === actual[index]?.semantic &&
        input.location === actual[index]?.location &&
        input.format === actual[index]?.format,
    )
  );
}

function hasMaterialResources(
  snapshot: RenderableSnapshot,
  receipt: MaterialShaderArtifactReceipt,
) {
  const textures = snapshot.material.textureHandles;
  const samplers = snapshot.material.samplerHandles;
  return receipt.resourceSlots.every((slot) => {
    const handles = slot.kind === 'texture' ? textures : samplers;
    return handles?.has(slot.parameter) === true;
  });
}

export function prepareGpuDrivenDraw(
  input: PrepareGpuDrivenDrawInput,
):
  | { readonly ok: true; readonly value: PreparedGpuDrivenDraw }
  | { readonly ok: false; readonly error: GpuDrivenPreparationError } {
  const receipt = input.artifact.receipt;
  if (receipt === undefined) {
    return failure('missing-material-receipt', {
      reason: 'material-receipt-missing',
      owner: 'material',
      expected: 'MaterialShaderArtifact.receipt',
    });
  }
  if (receipt.generation !== input.generation) {
    return failure('stale-generation', {
      reason: 'generation-stale',
      owner: 'generation',
      expectedGeneration: input.generation,
      actualGeneration: receipt.generation,
    });
  }
  if (receipt.reflection.layoutIdentity !== input.artifact.layoutIdentity) {
    return failure('reflection-mismatch', {
      reason: 'reflection-receipt-mismatch',
      owner: 'material',
      expected: input.artifact.layoutIdentity,
      actual: receipt.reflection.layoutIdentity,
    });
  }
  if (receipt.uvSets.some((uv) => uv.set > 0) && input.geometry.vertexInputs.length < 3) {
    return failure('missing-uv', {
      reason: 'uv-set-missing',
      owner: 'geometry',
      expected: `${receipt.uvSets.length} material UV sets`,
      actual: `${input.geometry.vertexInputs.filter((vertex) => vertex.semantic.startsWith('uv')).length} geometry UV sets`,
    });
  }
  if (!sameVertexInputs(receipt.vertexInputs, input.geometry.vertexInputs)) {
    return failure('vertex-input-mismatch', {
      reason: 'vertex-semantic-mismatch',
      owner: 'geometry',
      expected: receipt.vertexInputs.map((input) => input.semantic).join(','),
      actual: input.geometry.vertexInputs.map((input) => input.semantic).join(','),
    });
  }
  if (receipt.alphaMask.cutoff.length === 0) {
    return failure('alpha-mask-mismatch', {
      reason: 'alpha-mask-receipt-missing',
      owner: 'material',
      expected: 'alphaMask.cutoff',
    });
  }
  if (!hasMaterialResources(input.snapshot, receipt)) {
    return failure('resource-not-ready', {
      reason: 'material-resource-missing',
      owner: 'material',
      expected: receipt.resourceSlots.map((slot) => slot.parameter).join(','),
    });
  }
  const deformation = input.snapshot.skin === undefined ? 'rigid' : 'skin';
  if (deformation === 'skin') {
    if (input.skinReceipt === undefined || receipt.skinPaletteAddress === undefined) {
      return failure('skin-receipt-mismatch', {
        reason: 'skin-address-missing',
        owner: 'skin',
        expected: 'skinPaletteAddress and skinReceipt',
      });
    }
    if (
      input.skinReceipt.generation !== input.generation ||
      input.skinReceipt.group !== receipt.skinPaletteAddress.group ||
      input.skinReceipt.binding !== receipt.skinPaletteAddress.binding
    ) {
      return failure('skin-receipt-mismatch', {
        reason: 'skin-address-missing',
        owner: 'skin',
        expected: `${receipt.skinPaletteAddress.group}:${receipt.skinPaletteAddress.binding}@${input.generation}`,
        actual: `${input.skinReceipt.group}:${input.skinReceipt.binding}@${input.skinReceipt.generation}`,
      });
    }
  }
  return {
    ok: true,
    value: {
      identity: {
        material: input.artifact.material,
        geometry: input.geometry.identity,
        deformation,
      },
      receiptGeneration: receipt.generation,
      directEntry: receipt.directEntry,
      sceneIndexEntry: receipt.sceneIndexEntry,
      materialRow: receipt.materialRow,
      resourceSlots: receipt.resourceSlots,
      uvSets: receipt.uvSets,
      vertexInputs: receipt.vertexInputs,
      alphaMask: receipt.alphaMask,
      skinPaletteAddress: receipt.skinPaletteAddress,
      topology: input.draw.topology,
      indexed: input.draw.kind === 'indexed',
      first: input.draw.first,
      count: input.draw.count,
      baseVertex: input.draw.baseVertex,
    },
  };
}
