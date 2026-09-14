export const compareDecodedRgb = (left, right) => {
  const leftPixels = left?.pixels ?? left;
  const rightPixels = right?.pixels ?? right;
  const dimensionsMatch =
    Number.isInteger(leftPixels?.width) &&
    Number.isInteger(leftPixels?.height) &&
    leftPixels.width === rightPixels?.width &&
    leftPixels.height === rightPixels?.height;
  const hashesPresent = typeof leftPixels?.rgbHash === 'string' && typeof rightPixels?.rgbHash === 'string';
  const decodedRgbEqual = dimensionsMatch && hashesPresent && leftPixels.rgbHash === rightPixels.rgbHash;
  return {
    ok: dimensionsMatch && hashesPresent && !decodedRgbEqual,
    reason: !dimensionsMatch
      ? 'decoded-rgb-dimensions-mismatch'
      : !hashesPresent
        ? 'decoded-rgb-hash-missing'
        : decodedRgbEqual
          ? 'decoded-rgb-identical'
          : 'decoded-rgb-different',
    dimensionsMatch,
    hashesPresent,
    decodedRgbEqual,
    pngHashesEqual: typeof left?.sha256 === 'string' && left.sha256 === right?.sha256,
  };
};

export const validateMotionBlurTrace = (state, mode) => {
  const passes = Array.isArray(state?.passes) ? state.passes : [];
  const on = mode === 'on';
  const expected = on
    ? {
        enabled: true,
        status: 'active',
        temporalDemand: 'scene-data-temporal-v1',
        hasMotionBlurPass: true,
      }
    : mode === 'off'
      ? {
          enabled: false,
          status: 'off',
          temporalDemand: null,
        }
      : undefined;
  const hasMotionBlurPass = passes.includes('motion-blur');
  const outputTransformPresent = passes.includes('output-transform');
  return {
    ok:
      expected !== undefined &&
      state?.motionBlur?.enabled === expected.enabled &&
      state?.motionBlur?.status === expected.status &&
      state?.motionBlur?.temporalDemand === expected.temporalDemand &&
      (on ? hasMotionBlurPass === expected.hasMotionBlurPass : true) &&
      outputTransformPresent,
    mode,
    enabled: state?.motionBlur?.enabled,
    status: state?.motionBlur?.status,
    temporalDemand: state?.motionBlur?.temporalDemand,
    hasMotionBlurPass,
    outputTransformPresent,
  };
};
