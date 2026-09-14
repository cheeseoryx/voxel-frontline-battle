import { err, ok, type Result } from '@forgeax/engine-types';

export interface MotionBlurParams {
  readonly shutterAngle: number;
  readonly maxRadiusPixels: number;
  readonly sampleCount: number;
}

export const DEFAULT_MOTION_BLUR_PARAMS: MotionBlurParams = Object.freeze({
  shutterAngle: 180,
  maxRadiusPixels: 32,
  sampleCount: 8,
});

export interface MotionBlurInvalidParamsDetail {
  readonly field: keyof MotionBlurParams;
  readonly value: unknown;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}

export class MotionBlurValidationError extends Error {
  readonly code = 'motion-blur-invalid-params' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MotionBlurInvalidParamsDetail;

  constructor(detail: MotionBlurInvalidParamsDetail) {
    const integer = detail.integer === true ? 'integer ' : '';
    const expected = `${detail.field} ${integer}in [${detail.min}, ${detail.max}]`;
    super(`motion-blur-invalid-params: ${expected}`);
    this.name = 'MotionBlurValidationError';
    this.expected = expected;
    this.hint = `set ${detail.field} to an ${integer}value in [${detail.min}, ${detail.max}]`;
    this.detail = detail;
  }
}

function validateField(
  field: keyof MotionBlurParams,
  value: number,
  min: number,
  max: number,
  integer = false,
): MotionBlurValidationError | undefined {
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    return new MotionBlurValidationError({
      field,
      value,
      min,
      max,
      ...(integer ? { integer } : {}),
    });
  }
  return undefined;
}

export function validateMotionBlurParams(
  input: Partial<MotionBlurParams> | undefined,
): Result<MotionBlurParams, MotionBlurValidationError> {
  const value = input ?? {};
  const shutterAngle = value.shutterAngle ?? DEFAULT_MOTION_BLUR_PARAMS.shutterAngle;
  const maxRadiusPixels = value.maxRadiusPixels ?? DEFAULT_MOTION_BLUR_PARAMS.maxRadiusPixels;
  const sampleCount = value.sampleCount ?? DEFAULT_MOTION_BLUR_PARAMS.sampleCount;
  const shutterError = validateField('shutterAngle', shutterAngle, 0, 360);
  if (shutterError !== undefined) return err(shutterError);
  const radiusError = validateField('maxRadiusPixels', maxRadiusPixels, 0, 64);
  if (radiusError !== undefined) return err(radiusError);
  const sampleError = validateField('sampleCount', sampleCount, 4, 16, true);
  if (sampleError !== undefined) return err(sampleError);
  return ok(Object.freeze({ shutterAngle, maxRadiusPixels, sampleCount }));
}

export function motionBlurTemporalDemand(params: MotionBlurParams | undefined): boolean {
  return params !== undefined && params.shutterAngle > 0;
}

export function resolveMotionBlurParams(
  input: Partial<MotionBlurParams> | undefined,
): Result<MotionBlurParams | undefined, MotionBlurValidationError> {
  if (input === undefined) return ok(undefined);
  return validateMotionBlurParams(input);
}
