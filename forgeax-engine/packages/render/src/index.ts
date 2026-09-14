// @forgeax/engine-render — AI-facing render vocabulary.
//
// The root is deliberately small: ECS render components, grouped closed
// values, immutable frame facts, the renderer lifecycle/receipt contract, and
// the declarative RenderFeature plan. Graph builders, prepared GPU state, pipeline
// implementations, builtin feature factories, and diagnostic class names are
// owner-local implementation details.

export {
  materialContribution,
  renderPipelineContribution,
  samplerContribution,
} from './assets/asset-decoders';
// Runtime contract: leases, frame receipts, detached inspection, profile,
// lifecycle state, and the single renderer event stream.
export type {
  CubeCameraFaceView,
  CubeCameraFaceViewInput,
} from './capture/cube-views';
export { buildCubeCameraFaceViews } from './capture/cube-views';
export { Atmosphere } from './components/atmosphere';
// ECS render vocabulary and grouped closed values.
export type {
  Antialias,
  BloomEnabled,
  CameraData,
  CameraProjection,
  Tonemap,
} from './components/camera';
export {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  cameraProjectionFromF32,
  orthographic,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_NONE,
  TONEMAP_REINHARD,
  TONEMAP_REINHARD_EXTENDED,
} from './components/camera';
export {
  CUBE_CAMERA_FACE_ORDER,
  CUBE_CAMERA_UPDATE_CONTINUOUS,
  CUBE_CAMERA_UPDATE_ON_DEMAND,
  CUBE_CAMERA_UPDATE_ONCE,
  CubeCamera,
  type CubeCameraData,
  type CubeCameraFace,
  type CubeCameraUpdateIntent,
  cubeCameraUpdateIntentFromF32,
  cubeCameraUpdateIntentToF32,
} from './components/cube-camera';
export * from './components/directional-light';
export { Fog } from './components/fog';
export { Instances, type InstancesData } from './components/instances';
export { Layer } from './components/layer';
export * from './components/light-helpers';
export { LightProbe } from './components/light-probe';
export { Lines } from './components/lines';
export * from './components/mesh-filter';
export * from './components/mesh-renderer';
export { MotionBlur } from './components/motion-blur';
export { PointLight } from './components/point-light';
export { PointLightShadow } from './components/point-light-shadow';
export {
  type PointShape,
  PointShapeValue,
  Points,
  pointShapeFromU32,
} from './components/points';
export { PostProcessParams } from './components/post-process-params';
export { RectAreaLight } from './components/rect-area-light';
export {
  REFLECTION_PROBE_UPDATE_CONTINUOUS,
  REFLECTION_PROBE_UPDATE_ON_CHANGE,
  REFLECTION_PROBE_UPDATE_ONCE,
  ReflectionProbe,
  type ReflectionProbeData,
  type ReflectionProbeUpdateIntent,
  reflectionProbeUpdateIntentFromF32,
  reflectionProbeUpdateIntentToF32,
} from './components/reflection-probe';
export { SceneInstance } from './components/scene-instance';
export {
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  type SkyboxMode,
} from './components/skybox-background';
export { Skylight } from './components/skylight';
export { SortKey } from './components/sort-key';
export type { SpotLightAuthoring, SpotLightProjector } from './components/spot-light';
export { SpotLight } from './components/spot-light';
export {
  Visibility,
  type VisibilityState,
  VisibilityStateValue,
  visibilityStateFromU32,
} from './components/visibility';
export type {
  DynamicGeometryCandidate,
  DynamicGeometryCandidateState,
  DynamicGeometryErrorCode,
  DynamicGeometryErrorDetail,
  DynamicGeometryInspection,
  DynamicGeometryLifecycle,
  DynamicGeometryOrdering,
  DynamicGeometryPrepareInput,
  DynamicGeometryReceipt,
} from './dynamic-geometry';
export {
  createDynamicGeometryLifecycle,
  DynamicGeometryError,
} from './dynamic-geometry';
export type {
  EnvironmentInspection,
  EnvironmentInspectionFailure,
  EnvironmentInspectionGeneration,
  EnvironmentInspectionStatus,
} from './environment/inspection';
// Public structured operation failure union. Concrete error classes stay
// behind the Renderer Result/event boundary.
export type {
  ReflectionProbeBudgetExceededDetail,
  RenderError,
  RenderErrorCode,
  RenderIntentInvalidDetail,
  RenderTargetCapabilityMissingDetail,
  RenderTargetDescriptorInvalidDetail,
  RenderTargetOperationFailedDetail,
  RenderTargetStateInvalidDetail,
  SceneDataUnavailableDetail,
  SceneDataUnavailableReason,
} from './errors/render';
export {
  AtmosphereInvalidParameterError,
  EnvironmentGenerationFailedError,
  EnvironmentSourceConflictError,
  FogCardinalityError,
  OwnerStageFailedError,
  SceneDataUnavailableError,
  TaaCapsInsufficientError,
} from './errors/render';
export type {
  EnvironmentFrame,
  EnvironmentSource,
  FogFrame,
  FramePlan,
} from './extract/environment';
export {
  resolveVisibility,
  type VisibilityResolution,
  type VisibilitySnapshot,
} from './extract/visibility';
export type {
  RenderFeatureLogicalTarget,
  RenderFeatureMaterialShaderBindingContract,
  RenderFeaturePassDeclaration,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeatureResourceDeclaration,
} from './features/plan';
// Minimal declarative extension contract. Implementations use relative
// imports; the root does not expose prepared state, graph projectors, target
// handles, or builtin feature factories.
export type {
  RenderFeature,
  RenderFeatureCapabilityKey,
  RenderFeatureDiagnostics,
  RenderFeatureErrorDescriptor,
  RenderFeatureExtractContext,
  RenderFeatureHiddenEntityReport,
  RenderFeatureShaderModuleMode,
  RenderFeatureStatus,
  RenderFeatureWorldVisibilitySnapshot,
} from './features/types';
export {
  beginProbeIblUpdate,
  createIblKernelCache,
  createProbeIblOutput,
  type IblKernelCache,
  type ProbeIblOutput,
  type ProbeIblUpdate,
  publishProbeIblOutput,
  REFLECTION_PROBE_IBL_STAGES,
  type ReflectionProbeIblStage,
  resetIblKernelCaches,
} from './ibl/kernel-cache';
export type {
  BloomInspection,
  LightInspection,
  LodOcclusionInspection,
  MotionBlurInspection,
  MotionBlurInspectionStatus,
  ReflectionFallbackFailureStage,
  ReflectionFallbackInspection,
  ReflectionFallbackReadbackReceipt,
  ReflectionFallbackReceipt,
  ReflectionFallbackRecoveryAction,
  ReflectionProbeInspection,
  ReflectionProbeSelectionInspection,
  TransmissionInspection,
} from './inspection-types';
export type { InstanceCollectionInspection } from './instances';
export {
  type MaterialColorInput3,
  type MaterialColorInput4,
  type MaterialColorTuple3,
  type MaterialColorTuple4,
  Materials,
  MaterialTransmissionContractError,
  srgb,
} from './materials';
export {
  type MeshMaterialBindingObservation,
  type MeshMaterialBindingPreparationFailure,
  type MeshMaterialBindingReadiness,
  type MeshMaterialBindingResidency,
  type MeshMaterialBindingSamplerObservation,
  type MeshMaterialBindingSummary,
  type MeshMaterialBindingTextureObservation,
  projectMeshMaterialBindingObservation,
  summarizeMeshMaterialBindings,
} from './mesh-material-bindings';
export type {
  StandardClusterTransportInspection,
  StandardLightingInspection,
  StandardNoLocalLightingInspection,
} from './pipeline/standard-lighting/inspection';
// The host-facing default is a stable profile value; implementation-only
// pipeline helpers remain behind the package boundary.
export {
  DEFAULT_STANDARD_PROFILE,
  type StandardVolumetricFogProfile,
  type StandardVolumetricFogQuality,
} from './pipeline/standard-profile';
export { renderComponentsPlugin } from './plugin';
export {
  inspectPointShadow,
  type PointShadowInspection,
} from './point-shadow-inspection';
export {
  admitPointsLines,
  type LinesStyleInput,
  type PointsLinesAdmission,
  type PointsLinesAdmissionError,
  type PointsLinesAdmissionInput,
  type PointsLinesAdmissionLimits,
  type PointsStyleInput,
} from './points-lines/admission';
export type { PointsLinesInspection } from './points-lines/inspection';
/**
 * Public bounded GPU pass facts. Use the single `gpuPassTiming` opt-in,
 * `draw()` receipt, and `observe(receipt, { include: ['timings'] })` route.
 * Branch on the closed statuses `complete`, `partial`, `unavailable`, and
 * `failed`; each reason/error exposes `code`, `expected`, `hint`, and `detail`.
 * `latestKnownGood` is separate from current status and completeness. These
 * facts describe pass durations, never frame latency. The bounded contract is
 * in `record/gpu-pass-timing/contract.ts`; benchmark acceptance is fail-closed
 * in `bench/gpu-pass-timing/validator.ts`, and recovery follows the producer's
 * structured hint rather than a second timing API.
 */
export type {
  GpuPassTimingCapability,
  GpuPassTimingEntry,
  GpuPassTimingError,
  GpuPassTimingErrorCode,
  GpuPassTimingFrame,
  GpuPassTimingMeasuredEntry,
  GpuPassTimingMeasurementSource,
  GpuPassTimingObservation,
  GpuPassTimingOptions,
  GpuPassTimingPassIdentity,
  GpuPassTimingReason,
  GpuPassTimingReasonCode,
  GpuPassTimingRef,
  GpuPassTimingUnmeasuredEntry,
} from './record/gpu-pass-timing/index.js';
// Runtime contract: leases, frame receipts, detached inspection, profile,
// lifecycle state, and the single renderer event stream.
export {
  advanceProbeFilter,
  boxProjectReflectionDirection,
  commitProbeFilterStep,
  createProbeFilterState,
  type ProbeFilterState,
  probeFilterIsSteady,
} from './reflection/filter';
export {
  buildReflectionProbeTable,
  type ReflectionProbeTable,
  type ReflectionProbeTableRow,
  reflectionProbeTableBytes,
} from './reflection/gpu-table';
export {
  inspectReflectionFallback,
  type ReflectionFallbackFailureInput,
} from './reflection/inspection';
export {
  admitReflectionProbe,
  DEFAULT_REFLECTION_PROBE_LIMITS,
  estimateReflectionProbeBytes,
  type ReflectionProbeAdmission,
  type ReflectionProbeAdmissionLimits,
  type ReflectionProbeFact,
  type ReflectionProbeInput,
  ReflectionProbeProjection,
  type ReflectionProbeProjectionSnapshot,
  type ReflectionProbeSelection,
  type ReflectionProbeSelectionResult,
  type SkylightSelection,
  selectReflectionProbe,
  validateReflectionProbeInput,
} from './reflection/projection';
export type {
  CubeCameraSnapshot,
  FrameCamera,
  FrameEnvironment,
  FrameObservationRequest,
  FrameReceipt,
  FrameReceiptObservation,
  Renderer,
  RendererEvent,
  RendererOptions,
  RendererState,
  RenderFrameInput,
  RenderInspection,
  RenderProfile,
  RenderResult,
  RenderWorldLease,
} from './render-contract';
export { RENDER_PHASE_CATALOG } from './render-contract';
export type {
  TemporalInspectionInput,
  TemporalInspectionStatus,
} from './renderer-inspect';
export type {
  GpuFrameTiming,
  GpuFrameTimingProtocol,
  GpuFrameTimingRecord,
  GpuFrameTimingSample,
  GpuFrameTimingSummary,
} from './scene/visibility/gpu-frame-timing';
export {
  createGpuFrameTiming,
  recordGpuFrameTiming,
  summarizeGpuFrameTiming,
} from './scene/visibility/gpu-frame-timing';
export type {
  LodOcclusionDegradation,
  LodOcclusionFallback,
  LodOcclusionInspectionAction,
  LodOcclusionInspectionBudget,
  LodOcclusionInspectionError,
  LodOcclusionInspectionInput,
  LodOcclusionInspectionRow,
  LodOcclusionInspectionSample,
  LodOcclusionInspectionSubmit,
  LodOcclusionWorldAttribution,
  LodOcclusionWorldInspection,
  LodOcclusionWorldInspectionInput,
} from './scene/visibility/inspection';
export {
  consumeLodOcclusionInspection,
  inspectLodOcclusion,
  LOD_OCCLUSION_INSPECTION_MAX_BYTES,
  LOD_OCCLUSION_INSPECTION_SCHEMA,
  serializeLodOcclusionInspection,
} from './scene/visibility/inspection';
export {
  SHADOW_ATLAS_DEFAULT_FACE_SIZE,
  SHADOW_ATLAS_DEFAULT_LAYERS,
  ShadowAtlas,
} from './shadow-atlas';
export type {
  SsrAdmissionBudget,
  SsrAdmissionFailure,
  SsrAdmissionIdentity,
  SsrAdmissionInput,
  SsrAdmissionResult,
  SsrAdmissionWork,
  SsrDependenciesInspection,
  SsrFormatReceipt,
  SsrReflectionFallbackReceipt,
  SsrTemporalReceipt,
} from './ssr/admission';
export {
  admitSsrM0,
  projectSsrDependencies,
  resolveSsrAdmissionGeneration,
  SSR_FORMAT_PROFILE,
  SSR_FORMAT_STAGES,
  zeroSsrAdmissionWork,
} from './ssr/admission';
export {
  composeSsrReflection,
  type SsrCompositionInput,
  type SsrCompositionInputError,
  type SsrCompositionResult,
  type SsrReflectionColor,
} from './ssr/composition';
export { getActiveCamera, setActiveCamera } from './systems/active-camera';
export type {
  RenderTarget,
  RenderTargetAdmissionLimits,
  RenderTargetDepthFormat,
  RenderTargetDescriptor,
  RenderTargetFormat,
  RenderTargetMipLevels,
  RenderTargetReadbackData,
  RenderTargetReadbackRequest,
  RenderTargetReadbackTicket,
  RenderTargetSampleCount,
  RenderTargetShape,
  RenderTargetTextureAspect,
  RenderTargetTextureSource,
  RenderTargetTextureSourceOptions,
} from './targets/contracts';
export type { TemporalInspection, TemporalResourceInspection } from './temporal/inspection';
export {
  SCENE_DATA_TEMPORAL_V1_DESCRIPTOR,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  type SceneDataLane,
  type SceneDataSchemaId,
  type SceneDataTarget,
  type SceneDataTemporalV1Descriptor,
} from './temporal/scene-data';
export {
  createSceneDataCatalog,
  type SceneDataAvailability,
  type SceneDataCatalog,
  type SceneDataCatalogOptions,
  type SceneDataInspection,
} from './temporal/scene-data-catalog';
export type { TemporalView } from './temporal/view';
export {
  hasVolumetricFogCapability,
  type IntegratedVolumeResource,
  resolveIntegratedVolumeConsumer,
  resolveSelectedVolumetricLight,
  resolveVolumetricFogLightPair,
  type VolumeConsumer,
  type VolumetricFogLightKind,
  type VolumetricFogLightPairResolution,
  type VolumetricFogLightResolution,
} from './volume/capability';
export {
  type ValidatedVolumetricFog,
  type VolumeBounds,
  type VolumeDensityBinding,
  VolumetricFog,
  type VolumetricFogAuthoring,
  type VolumetricFogLightSelection,
  validateVolumetricFog,
} from './volume/component';
export { extractVolumetricFog, type VolumetricFogExtract } from './volume/extract';
export {
  inspectVolumetricFog,
  type VolumetricFogInspection,
  type VolumetricFogInspectionInput,
  type VolumetricFogInspectionStatus,
  type VolumetricFogResourceStage,
} from './volume/inspection';
