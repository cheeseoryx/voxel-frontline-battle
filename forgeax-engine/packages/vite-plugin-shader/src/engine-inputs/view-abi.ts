/**
 * Typed transport description for the shared View uniform block.
 *
 * This is metadata only: it names the shader module and binding plus the
 * stable byte offsets consumed by the Host upload path. It never contains a
 * GPU buffer, texture view, or device handle.
 */
export interface ViewAbiField {
  readonly name: string;
  readonly offsetBytes: number;
  readonly sizeBytes: number;
}

export interface ViewAbi {
  readonly moduleId: 'forgeax_view::common';
  readonly group: 0;
  readonly binding: 0;
  readonly byteLength: 960;
  readonly fields: readonly ViewAbiField[];
}

export const VIEW_ABI: ViewAbi = Object.freeze({
  moduleId: 'forgeax_view::common',
  group: 0,
  binding: 0,
  byteLength: 960,
  fields: Object.freeze([
    { name: 'worldViewProj', offsetBytes: 0, sizeBytes: 64 },
    { name: 'inverseViewProj', offsetBytes: 176, sizeBytes: 64 },
    { name: 'spotLightViewProj', offsetBytes: 528, sizeBytes: 256 },
    { name: 'temporalProjection', offsetBytes: 784, sizeBytes: 16 },
    { name: 'fog', offsetBytes: 800, sizeBytes: 32 },
  ]),
});
