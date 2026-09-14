import { VIEW_UNIFORM_BUFFER_SIZE } from '../record/view-ubo';

/** Generation-scoped buffer and attachment constants used by the ready builder. */
export const VIEW_UBO_BYTES = VIEW_UNIFORM_BUFFER_SIZE;
export const MIPMAP_PREWARM_FORMATS: readonly GPUTextureFormat[] = [
  'rgba8unorm-srgb',
  'rgba8unorm',
  'rgba16float',
];
export const BRIGHT_PARAMS_BYTES = 16;
export const BLUR_PARAMS_BYTES = 16;
export const COMPOSITE_PARAMS_BYTES = 16;
export const HDR_COLOR_ATTACHMENT_FORMAT: GPUTextureFormat = 'rgba16float';
export const DEPTH_TEXTURE_FORMAT: GPUTextureFormat = 'depth24plus-stencil8';
