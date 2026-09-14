export const STANDARD_PIPELINE_ID = 'forgeax::standard' as const;
export const STANDARD_LIGHT_COUNTS = [1, 32, 256] as const;
export {
  CLUSTER_GRID_STRIDE_U32,
  DEFAULT_CLUSTER_GRID,
  LIGHT_INDEX_LIST_CAPACITY,
  MAX_LIGHTS,
} from './standard-lighting/layout';

export type StandardLightCount = (typeof STANDARD_LIGHT_COUNTS)[number];
export type StandardShadowMode = 'off' | 'hard' | 'filtered';
export type StandardVolumetricFogQuality = 'low' | 'high';

export interface StandardVolumetricFogProfile {
  readonly quality: StandardVolumetricFogQuality;
  readonly depth: 48 | 64;
  readonly tileSize: 4 | 16;
}

export const STANDARD_POST_STAGE_NAMES = [
  'transparent-blend',
  'bloom',
  'output-transform',
  'fxaa',
  'post-effect',
  'present',
] as const;
export type StandardPostStage = (typeof STANDARD_POST_STAGE_NAMES)[number];
export interface StandardProfile {
  readonly pipelineId: typeof STANDARD_PIPELINE_ID;
  readonly lightCount: StandardLightCount;
  /** Graph topology selector; all local lights use the shared Cluster path. */
  readonly renderPath: 'forward' | 'deferred';
  readonly shadows: StandardShadowMode;
  readonly pbr: boolean;
  readonly ibl: boolean;
  readonly ssao: boolean;
  /** Renderer-owned 1080p volume profile; tile width/height remain surface-derived. */
  readonly volumetricFog?: StandardVolumetricFogProfile | undefined;
  readonly postStages: typeof STANDARD_POST_STAGE_NAMES;
}

export const DEFAULT_STANDARD_PROFILE: StandardProfile = Object.freeze({
  pipelineId: STANDARD_PIPELINE_ID,
  lightCount: 32,
  renderPath: 'forward',
  shadows: 'filtered',
  pbr: true,
  ibl: true,
  ssao: false,
  postStages: STANDARD_POST_STAGE_NAMES,
});

export function resolveVolumetricFogProfile(
  profile: Pick<StandardProfile, 'volumetricFog'>,
): StandardVolumetricFogProfile {
  return profile.volumetricFog ?? { quality: 'high', depth: 64, tileSize: 4 };
}
