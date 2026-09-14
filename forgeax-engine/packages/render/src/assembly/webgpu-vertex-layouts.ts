import type { GpuVertexBufferLayoutEntry } from '@forgeax/engine-geometry';
import type { VertexAttributeMap } from '@forgeax/engine-types';

// feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4): a single
// shared empty ArrayBuffer used by the pipeline builder to synthesize the
// pbr-skin attribute map when no caller-supplied attributes are available.
// `deriveVertexBufferLayout` is the SSOT for the layout and reads only key
// presence, so a zero-byte buffer per key preserves the six-attribute stride.
export const PBR_SKIN_SENTINEL_ATTR_BUFFER = new ArrayBuffer(0);

/** Default 4-attribute vertex layout used as fallback when meshAttributes is undefined. */
export const DEFAULT_VERTEX_ATTRS: VertexAttributeMap = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  tangent: new Float32Array(0),
};

export const PREPARED_INSTANCE_VERTEX_ATTRS: VertexAttributeMap = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  tangent: new Float32Array(0),
  uv1: new Float32Array(0),
};

export const PREPARED_MATERIAL_INSTANCE_VERTEX_ATTRS: VertexAttributeMap = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  tangent: new Float32Array(0),
  skinIndex: new Uint16Array(0),
  skinWeight: new Float32Array(0),
};

export const POSITION_SIZE_COLOR_INSTANCE_VERTEX_BUFFERS = [
  {
    arrayStride: 9 * 4,
    stepMode: 'instance' as const,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
      { shaderLocation: 1, offset: 3 * 4, format: 'float32x2' as const },
      { shaderLocation: 2, offset: 5 * 4, format: 'float32x4' as const },
    ],
  },
] satisfies readonly GPUVertexBufferLayout[];

export const BILLBOARD_MATERIAL_INSTANCE_VERTEX_BUFFERS = [
  {
    arrayStride: 31 * 4,
    stepMode: 'instance' as const,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
      { shaderLocation: 1, offset: 3 * 4, format: 'float32x2' as const },
      { shaderLocation: 2, offset: 5 * 4, format: 'float32x2' as const },
      { shaderLocation: 3, offset: 7 * 4, format: 'float32x4' as const },
      { shaderLocation: 4, offset: 11 * 4, format: 'float32x4' as const },
      { shaderLocation: 5, offset: 15 * 4, format: 'float32x4' as const },
      { shaderLocation: 6, offset: 19 * 4, format: 'float32x4' as const },
      { shaderLocation: 7, offset: 23 * 4, format: 'float32x4' as const },
      { shaderLocation: 8, offset: 27 * 4, format: 'float32x4' as const },
    ],
  },
] satisfies readonly GPUVertexBufferLayout[];

export const TOPOLOGY_SEGMENT_INSTANCE_VERTEX_BUFFERS = [
  {
    arrayStride: 12 * 4,
    stepMode: 'instance' as const,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
      { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' as const },
      { shaderLocation: 2, offset: 6 * 4, format: 'float32x4' as const },
      { shaderLocation: 3, offset: 10 * 4, format: 'float32x2' as const },
    ],
  },
] satisfies readonly GPUVertexBufferLayout[];

export const MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS = [
  {
    arrayStride: 12 * 4,
    stepMode: 'vertex' as const,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
      { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' as const },
      { shaderLocation: 2, offset: 6 * 4, format: 'float32x2' as const },
      { shaderLocation: 3, offset: 8 * 4, format: 'float32x4' as const },
    ],
  },
  {
    arrayStride: 28 * 4,
    stepMode: 'instance' as const,
    attributes: [
      { shaderLocation: 4, offset: 0, format: 'float32x3' as const },
      { shaderLocation: 5, offset: 3 * 4, format: 'float32x3' as const },
      { shaderLocation: 6, offset: 6 * 4, format: 'float32x3' as const },
      { shaderLocation: 7, offset: 9 * 4, format: 'float32x3' as const },
      { shaderLocation: 8, offset: 12 * 4, format: 'float32x4' as const },
      { shaderLocation: 9, offset: 16 * 4, format: 'float32x4' as const },
      { shaderLocation: 10, offset: 20 * 4, format: 'float32x4' as const },
      { shaderLocation: 11, offset: 24 * 4, format: 'float32x4' as const },
    ],
  },
] satisfies readonly GPUVertexBufferLayout[];

function toGpuVertexFormat(
  format: GpuVertexBufferLayoutEntry['attributes'][number]['format'],
): GPUVertexFormat {
  switch (format) {
    case 'float32x2':
    case 'float32x3':
    case 'float32x4':
    case 'uint16x4':
      return format;
    default:
      throw new Error(`Unsupported geometry vertex format: ${format}`);
  }
}

export function toGpuVertexBufferLayouts(
  entries: readonly GpuVertexBufferLayoutEntry[],
): readonly GPUVertexBufferLayout[] {
  return entries.map((entry) => ({
    arrayStride: entry.arrayStride,
    ...(entry.stepMode === undefined ? {} : { stepMode: entry.stepMode }),
    attributes: entry.attributes.map((attribute) => ({
      shaderLocation: attribute.shaderLocation,
      offset: attribute.offset,
      format: toGpuVertexFormat(attribute.format),
    })),
  }));
}
