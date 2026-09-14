import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  MESH_BIN_HEADER_V4_BYTES,
  type MeshBinContractError,
  type MeshBinHeaderV4,
  writeMeshBinHeader,
} from '@forgeax/engine-pack/mesh-bin-contract';
import {
  err,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';

type MeshPayloadIn = { readonly [Key in keyof MeshAsset]?: MeshAsset[Key] | undefined } & {
  readonly vertexCount?: number;
};

export type MeshBinEncodeError =
  | MeshBinContractError
  | {
      readonly code: 'mesh-bin-payload-invalid';
      readonly subject: 'mesh-bin';
      readonly sourceKey: string;
      readonly expected: string;
      readonly actual: string;
      readonly recovery: string;
    };

function failure(sourceKey: string, expected: string, actual: string): MeshBinEncodeError {
  return {
    code: 'mesh-bin-payload-invalid',
    subject: 'mesh-bin',
    sourceKey,
    expected,
    actual,
    recovery: 're-cook the source with its Meta sidecar through the build-time importer',
  };
}

function asAttributeMap(value: unknown): VertexAttributeMap {
  return (value ?? {}) as VertexAttributeMap;
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Float32Array || value instanceof Uint16Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, jsonValue(nested)]),
    );
  }
  return value;
}

function refsMeta(payload: MeshPayloadIn, refs: readonly string[]): Record<string, unknown> {
  const materialSlots = (payload.materialSlots ?? [{ slotName: 'Default' }]).map(
    (slot, slotIndex) => {
      const defaultMaterial = slot.defaultMaterial;
      let defaultMaterialRef: number | undefined;
      if (defaultMaterial !== undefined) {
        const guid = AssetGuid.format(defaultMaterial);
        defaultMaterialRef = refs.findIndex((candidate) => candidate.toLowerCase() === guid);
        if (defaultMaterialRef < 0) {
          throw new Error(
            `material slot ${slotIndex} default material ${guid} is absent from refs`,
          );
        }
      }
      return {
        slotName: slot.slotName,
        ...(slot.sourceKey === undefined ? {} : { sourceKey: slot.sourceKey }),
        ...(defaultMaterialRef === undefined ? {} : { defaultMaterialRef }),
      };
    },
  );
  if (payload.lods !== undefined && payload.lods.length > 7) {
    throw new Error('MeshAsset LOD chain supports at most seven lower-detail levels');
  }
  let previousCoverage = 1;
  const seenLodGuids = new Set<string>();
  const lods = payload.lods?.map((lod, lodIndex) => {
    const guid = AssetGuid.format(lod.mesh).toLowerCase();
    const meshRef = refs.findIndex((candidate) => candidate.toLowerCase() === guid);
    if (meshRef < 0) {
      throw new Error(`LOD ${lodIndex} mesh ${guid} is absent from refs`);
    }
    if (seenLodGuids.has(guid)) {
      throw new Error(`LOD ${lodIndex} mesh ${guid} is duplicated`);
    }
    if (
      !Number.isFinite(lod.screenCoverage) ||
      lod.screenCoverage <= 0 ||
      lod.screenCoverage > 1 ||
      lod.screenCoverage >= previousCoverage
    ) {
      throw new Error(
        `LOD ${lodIndex} screenCoverage must be finite, in (0, 1], and strictly decreasing`,
      );
    }
    seenLodGuids.add(guid);
    previousCoverage = lod.screenCoverage;
    return { meshRef, screenCoverage: lod.screenCoverage };
  });
  if (
    payload.lodHysteresis !== undefined &&
    (!Number.isFinite(payload.lodHysteresis) ||
      payload.lodHysteresis < 0 ||
      payload.lodHysteresis >= 1)
  ) {
    throw new Error('lodHysteresis must be finite and in [0, 1)');
  }
  return {
    submeshes:
      payload.submeshes === undefined || payload.submeshes.length === 0
        ? [{ indexOffset: 0, indexCount: payload.indices?.length ?? 0, materialSlot: 0 }]
        : payload.submeshes,
    materialSlots,
    ...(payload.aabb === undefined ? {} : { aabb: jsonValue(payload.aabb) }),
    ...(payload.morphTargets === undefined
      ? {}
      : { morphTargets: jsonValue(payload.morphTargets) }),
    ...(payload.morphWeights === undefined
      ? {}
      : { morphWeights: jsonValue(payload.morphWeights) }),
    ...(lods === undefined ? {} : { lods }),
    ...(payload.lodHysteresis === undefined ? {} : { lodHysteresis: payload.lodHysteresis }),
  };
}

/** Encode one canonical v4 mesh binary. No legacy version is accepted or emitted. */
export function packMeshBinV4(
  payload: MeshPayloadIn,
  sourceKey: string,
  refs: readonly string[] = [],
): Result<Uint8Array, MeshBinEncodeError> {
  try {
    const vertices = payload.vertices;
    const indices = payload.indices;
    if (!(vertices instanceof Float32Array)) {
      return err(
        failure(sourceKey, 'Float32Array interleaved vertices', 'vertices is not Float32Array'),
      );
    }
    if (
      indices !== undefined &&
      !(indices instanceof Uint16Array || indices instanceof Uint32Array)
    ) {
      return err(
        failure(sourceKey, 'Uint16Array or Uint32Array indices', 'indices has an unsupported type'),
      );
    }
    const attributes = asAttributeMap(payload.attributes);
    const projection = deriveVertexLayoutProjection(attributes);
    if (projection.attributes.length === 0 || projection.arrayStride === 0) {
      return err(
        failure(
          sourceKey,
          'a non-empty canonical geometry projection',
          'projection has no attributes',
        ),
      );
    }
    const vertexCount = payload.vertexCount ?? vertices.byteLength / projection.arrayStride;
    if (!Number.isSafeInteger(vertexCount) || vertexCount < 0) {
      return err(
        failure(sourceKey, 'a non-negative safe vertex cardinality', `vertexCount=${vertexCount}`),
      );
    }
    if (vertices.byteLength !== vertexCount * projection.arrayStride) {
      return err(
        failure(
          sourceKey,
          `vertices.byteLength=${vertexCount * projection.arrayStride}`,
          `vertices.byteLength=${vertices.byteLength}; stride=${projection.arrayStride}`,
        ),
      );
    }
    for (const attribute of projection.attributes) {
      const value = attributes[attribute.key];
      const components = attribute.byteLength / (attribute.format === 'uint16x4' ? 2 : 4);
      if (
        value === undefined ||
        (!(value instanceof Float32Array) && !(value instanceof Uint16Array)) ||
        value.length !== vertexCount * components
      ) {
        return err(
          failure(
            sourceKey,
            `${attribute.key} cardinality=${vertexCount * components}`,
            `${attribute.key} cardinality=${value?.byteLength ?? 'missing'}`,
          ),
        );
      }
    }
    const interleaved = new Uint8Array(vertexCount * projection.arrayStride);
    const interleavedView = new DataView(interleaved.buffer);
    for (const attribute of projection.attributes) {
      const value = attributes[attribute.key];
      if (value === undefined) continue;
      const components = attribute.byteLength / (attribute.format === 'uint16x4' ? 2 : 4);
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        for (let component = 0; component < components; component++) {
          const sourceIndex = vertex * components + component;
          const targetOffset =
            vertex * projection.arrayStride +
            attribute.offset +
            component * (attribute.format === 'uint16x4' ? 2 : 4);
          if (attribute.format === 'uint16x4') {
            interleavedView.setUint16(targetOffset, (value as Uint16Array)[sourceIndex] ?? 0, true);
          } else {
            interleavedView.setFloat32(
              targetOffset,
              (value as Float32Array)[sourceIndex] ?? 0,
              true,
            );
          }
        }
      }
    }
    const indexCount = indices?.length ?? 0;
    const indexWidth = indices === undefined || indexCount === 0 ? 0 : indices.BYTES_PER_ELEMENT;
    const indexBytes = indexCount * indexWidth;
    if (!Number.isSafeInteger(indexBytes) || indexBytes > 0xffffffff) {
      return err(failure(sourceKey, 'safe index payload byte length', `indexBytes=${indexBytes}`));
    }
    const meta = new TextEncoder().encode(JSON.stringify(refsMeta(payload, refs)));
    const header: MeshBinHeaderV4 = {
      version: 4,
      projectionVersion: projection.schemaVersion,
      mask: projection.mask,
      digest: projection.digest,
      stride: projection.arrayStride,
      vertexCount,
      vertexBytes: interleaved.byteLength,
      indexCount,
      indexWidth: indexWidth as 0 | 2 | 4,
      indexBytes,
      jsonBytes: meta.byteLength,
    };
    const total = MESH_BIN_HEADER_V4_BYTES + interleaved.byteLength + indexBytes + meta.byteLength;
    if (!Number.isSafeInteger(total) || total > 0xffffffff) {
      return err(failure(sourceKey, 'safe mesh binary byte length', `total=${total}`));
    }
    const out = new Uint8Array(total);
    writeMeshBinHeader(header, out);
    let offset = MESH_BIN_HEADER_V4_BYTES;
    out.set(interleaved, offset);
    offset += interleaved.byteLength;
    if (indices !== undefined && indexBytes > 0) {
      out.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset);
      offset += indexBytes;
    }
    out.set(meta, offset);
    return ok(out);
  } catch (error) {
    return err(
      failure(
        sourceKey,
        'valid canonical mesh payload',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}
