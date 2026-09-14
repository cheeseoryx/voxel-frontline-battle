// Non-stable implementation seam for engine-owned consumers and tests.

export {
  type ResolvedTilesetRuntime,
  resolveTilesetRuntime,
  type TilesetAtlasLookup,
  type TilesetRuntimeError,
  type TilesetRuntimeErrorCode,
} from '@forgeax/engine-assets-runtime';
export { DeviceScope } from './device/device-scope';
export { createLightResourceUnavailable } from './errors/render';
export {
  deriveLtcResourcePlan,
  type LtcResourcePlan,
} from './prepare/extended-lighting/ltc-resources';
export {
  deriveExtendedLightingCapability,
  EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES,
  type ExtendedLightingCapabilityResult,
  type ExtendedLightingResourceCandidate,
  extendedLightingSampledTextureCapacityAvailable,
} from './prepare/extended-lighting/resources';
export {
  createExtendedLightingState,
  type ExtendedLightingState,
  projectExtendedLightingInspection,
  promoteExtendedLightingCandidate,
  recordExtendedLightingFailure,
} from './prepare/extended-lighting/state';
export {
  type GraphTargetCaptureReadbackValidation,
  validateGraphTargetCaptureReadback,
} from './record/frame-snapshot';
export {
  buildRectAreaWorldFrame,
  rectAreaFacesPoint,
} from './render-system-extract';
export {
  admitProbeContributors,
  blendLightProbes,
  PROBE_MAX_CONTRIBUTORS,
  scaledProbeWeight,
} from './scene/probe-blend';
export {
  createVisibilityBudget,
  type VisibilityBudget,
} from './scene/visibility/budget';
export {
  type OcclusionRuntimeTestHooks,
  setOcclusionRuntimeTestHooks,
} from './scene/visibility/occlusion-runtime';
export { TemporalFrameCoordinator } from './temporal/frame-coordinator';
