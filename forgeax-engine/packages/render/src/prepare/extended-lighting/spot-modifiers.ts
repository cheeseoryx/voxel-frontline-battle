import type { TextureAsset } from '@forgeax/engine-types';
import { COOKIE_SLICE_SIZE } from './resources';

export interface SpotModifierFactors {
  readonly brdf: number;
  readonly range: number;
  readonly cone: number;
  readonly ies?: number | undefined;
  readonly cookie?: number | undefined;
  readonly shadow: number;
}

export interface IesCoordinates {
  readonly azimuth: number;
  readonly elevation: number;
}

export interface CookieUv {
  readonly u: number;
  readonly v: number;
}

/**
 * The fixed GPU representation consumed by the extended-lighting Cookie
 * array. The matrix is deliberately keyed by Cookie slice rather than by
 * light: it carries only the source texture aspect correction. The shader
 * still owns the light-local basis, roll, and outer-cone projection, so one
 * Cookie can be shared by Spots with different directions or cone angles.
 */
export interface CookieProjection {
  readonly data: Uint8Array;
  readonly matrix: Float32Array;
  readonly aspect: number;
}

const DEG_TO_RAD = Math.PI / 180;

const COOKIE_PROJECTION_CACHE = new WeakMap<TextureAsset, CookieProjection | null>();

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sourceChannel(asset: TextureAsset, x: number, y: number, channel: number): number {
  const offset = (y * asset.shape.extent.width + x) * 4 + channel;
  const encoded = (asset.data[offset] ?? 0) / 255;
  return channel < 3 && asset.colorSpace === 'srgb' ? srgbToLinear(encoded) : encoded;
}

function sampleSourceChannel(asset: TextureAsset, x: number, y: number, channel: number): number {
  const sourceX = clamp01((x + 0.5) / COOKIE_SLICE_SIZE) * (asset.shape.extent.width - 1);
  const sourceY = clamp01((y + 0.5) / COOKIE_SLICE_SIZE) * (asset.shape.extent.height - 1);
  const x0 = Math.floor(sourceX);
  const y0 = Math.floor(sourceY);
  const x1 = Math.min(asset.shape.extent.width - 1, x0 + 1);
  const y1 = Math.min(asset.shape.extent.height - 1, y0 + 1);
  const tx = sourceX - x0;
  const ty = sourceY - y0;
  const top =
    sourceChannel(asset, x0, y0, channel) * (1 - tx) + sourceChannel(asset, x1, y0, channel) * tx;
  const bottom =
    sourceChannel(asset, x0, y1, channel) * (1 - tx) + sourceChannel(asset, x1, y1, channel) * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Project a filterable 2D RGBA Cookie into the renderer's fixed linear
 * 256x256 array slice. This is a producer-boundary operation and is cached by
 * the immutable TextureAsset object, so the frame path never decodes or
 * resamples the source repeatedly.
 */
export function prepareCookieProjection(asset: TextureAsset): CookieProjection | undefined {
  if (COOKIE_PROJECTION_CACHE.has(asset)) {
    return COOKIE_PROJECTION_CACHE.get(asset) ?? undefined;
  }
  const supportedFormat = asset.format === 'rgba8unorm' || asset.format === 'rgba8unorm-srgb';
  const validDimensions =
    Number.isSafeInteger(asset.shape.extent.width) &&
    Number.isSafeInteger(asset.shape.extent.height) &&
    asset.shape.extent.width > 0 &&
    asset.shape.extent.height > 0;
  const validFormatPair =
    (asset.format === 'rgba8unorm-srgb' && asset.colorSpace === 'srgb') ||
    (asset.format === 'rgba8unorm' && asset.colorSpace === 'linear');
  const validPayload =
    asset.data.byteLength >= asset.shape.extent.width * asset.shape.extent.height * 4;
  if (!supportedFormat || !validDimensions || !validFormatPair || !validPayload) {
    COOKIE_PROJECTION_CACHE.set(asset, null);
    return undefined;
  }

  const data = new Uint8Array(COOKIE_SLICE_SIZE * COOKIE_SLICE_SIZE * 4);
  for (let y = 0; y < COOKIE_SLICE_SIZE; y += 1) {
    for (let x = 0; x < COOKIE_SLICE_SIZE; x += 1) {
      const target = (y * COOKIE_SLICE_SIZE + x) * 4;
      data[target] = Math.round(clamp01(sampleSourceChannel(asset, x, y, 0)) * 255);
      data[target + 1] = Math.round(clamp01(sampleSourceChannel(asset, x, y, 1)) * 255);
      data[target + 2] = Math.round(clamp01(sampleSourceChannel(asset, x, y, 2)) * 255);
      // Alpha stays linear and is intentionally preserved: the shader
      // multiplies sampled RGB by this lane as part of Cookie semantics.
      data[target + 3] = Math.round(clamp01(sampleSourceChannel(asset, x, y, 3)) * 255);
    }
  }

  // Column-major mat4. The shader multiplies the unprojected local
  // (x/depth, y/depth) pair by this aspect-only matrix, then applies the
  // Spot's outer-cone tangent and the [0,1] translation. Keeping outerCone
  // out of this slice-keyed matrix allows one Cookie to be shared by lights.
  const matrix = new Float32Array(16);
  matrix[0] = asset.shape.extent.height / asset.shape.extent.width;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  const projection = {
    data,
    matrix,
    aspect: asset.shape.extent.width / asset.shape.extent.height,
  };
  COOKIE_PROJECTION_CACHE.set(asset, projection);
  return projection;
}

/** Create the deterministic identity payload used for unused Cookie slices. */
export function createCookieProjectionMatrixData(count: number): Float32Array {
  const data = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    const base = index * 16;
    data[base] = 1;
    data[base + 5] = 1;
    data[base + 10] = 1;
    data[base + 15] = 1;
  }
  return data;
}

function normalized(vector: ArrayLike<number>): [number, number, number] | undefined {
  const x = vector[0] ?? 0;
  const y = vector[1] ?? 0;
  const z = vector[2] ?? 0;
  const length = Math.hypot(x, y, z);
  return length > 0 && Number.isFinite(length) ? [x / length, y / length, z / length] : undefined;
}

export function spotModifierProduct(factors: SpotModifierFactors): number {
  return (
    factors.brdf *
    factors.range *
    factors.cone *
    (factors.ies ?? 1) *
    (factors.cookie ?? 1) *
    factors.shadow
  );
}

export function projectIesCoordinates(
  toPoint: ArrayLike<number>,
  rollDeg: number,
): IesCoordinates | undefined {
  const direction = normalized(toPoint);
  if (direction === undefined || direction[2] >= 0) return undefined;
  const roll = rollDeg * DEG_TO_RAD;
  const rolledX = direction[0] * Math.cos(roll) - direction[1] * Math.sin(roll);
  const rolledY = direction[0] * Math.sin(roll) + direction[1] * Math.cos(roll);
  return {
    azimuth: (Math.atan2(rolledY, rolledX) + Math.PI * 2) % (Math.PI * 2),
    elevation: Math.acos(Math.min(1, Math.max(-1, -direction[2]))) / Math.PI,
  };
}

export function projectCookieUv(
  toPoint: ArrayLike<number>,
  rollDeg: number,
  aspect: number,
  outerConeDeg = 45,
): CookieUv | undefined {
  const direction = normalized(toPoint);
  if (direction === undefined || direction[2] >= 0 || !Number.isFinite(aspect) || aspect <= 0)
    return undefined;
  const cone = Math.atan2(Math.hypot(direction[0], direction[1]), -direction[2]);
  const outerCone = outerConeDeg * DEG_TO_RAD;
  if (cone > outerCone) return undefined;
  const roll = rollDeg * DEG_TO_RAD;
  const x = direction[0] * Math.cos(roll) - direction[1] * Math.sin(roll);
  const y = direction[0] * Math.sin(roll) + direction[1] * Math.cos(roll);
  const scale = Math.tan(outerCone);
  return {
    u: 0.5 + (x / -direction[2] / scale / aspect) * 0.5,
    v: 0.5 + (y / -direction[2] / scale) * 0.5,
  };
}
