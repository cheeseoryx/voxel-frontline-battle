#define_import_path forgeax_material::standard
#pragma material_slot surface
#import forgeax_material::slot::surface::{evaluate_surface}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_view::common::{View, Mesh, InstanceData, view, meshes, instances, shadowMap, shadowSampler, sampleMaterialTexture}
#import forgeax_scene_temporal::{sceneViewZ}
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{spotModifierSampler, iesProfileTexture, cookieTexture, cookieMatrices}
#endif
#ifdef PROJECTOR_AVAILABLE
#ifndef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{projectorTexture, projectorSampler}
#endif
#endif
#import forgeax_pbr::temporal::{projectPbrSceneTemporal}
#import forgeax_pbr::brdf::{f_schlick, v_smith, d_ggx}
#import forgeax_pbr::ibl_sampling::{box_project, sampleIblDiffuse, sampleIblSpecular, sampleReflectionProbeSpecular}
#import forgeax_pbr::lighting_probe::{evaluateProbeDiffuse}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, scaleTangentSpaceNormal, applyTBN}
#ifdef CLEARCOAT_AVAILABLE
#import forgeax_pbr::clearcoat::{evaluateClearcoatLayer}
#endif
#ifdef ANISOTROPY_AVAILABLE
#import forgeax_pbr::anisotropy::{evaluateAnisotropicNormal}
#endif
#ifdef SHEEN_AVAILABLE
#import forgeax_pbr::sheen::{evaluateSheenLayer}
#endif
#ifdef IRIDESCENCE_AVAILABLE
#import forgeax_pbr::iridescence::{evaluateIridescenceFresnel}
#endif
#import forgeax_pbr::lighting_directional::{evalDirectionalNoShadow, evalDirectionalShadowFactor}
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster::{evaluateStandardClusterLights, get_ssao_intensity}
#endif

#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE
#pragma variant_axis VERTEX_COLOR_AVAILABLE
#pragma variant_axis PROBE_BLEND_AVAILABLE
#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE
#pragma variant_axis TRANSMISSION_AVAILABLE
#pragma variant_axis DIRECTIONAL_PCSS_AVAILABLE
#pragma variant_axis PROJECTOR_AVAILABLE
#pragma variant_axis REFLECTION_FALLBACK_AVAILABLE

// reflection_probe is a scene-projected Standard material lane. Its optional
// texture arguments stay binding-free here; the host selects the bounded table
// row and falls back to the Skylight helpers when no candidate is admitted.
// Keep this compile-time witness in the probe variant only: authored physical
// aliases intentionally flatten renderer-owned probe axes, and naga_oil must
// not resolve a probe-only helper for those roots.
#ifdef PROBE_BLEND_AVAILABLE
fn reflection_probe_sampling_contract(
  worldPosition: vec3<f32>,
  direction: vec3<f32>,
  boxCenter: vec3<f32>,
  boxExtents: vec3<f32>,
) -> vec3<f32> {
  return box_project(worldPosition, direction, boxCenter, boxExtents);
}
#endif

// @forgeax/engine-shader - default-standard-pbr.wgsl
// (feat-20260523-shader-template-instance-split M5 / T04).
//
// Engine-shipped default standard PBR material shader, registered under the
// reserved path identifier `forgeax::default-standard-pbr` (plan-strategy
// D-DefaultStandardPbr-Identifier + plan-strategy section 8.2). This file is
// the M5 successor to the monolithic `pbr.wgsl`; the BRDF / IBL / TBN /
// lighting helpers all live in independent ShaderModules and are pulled in
// via naga_oil #import (charter F1 grep gate -- AI users grep the #import
// header to enumerate every helper dependency in one shot).
//
// Bindings (4 BG layout slots; View + Mesh bindings inherited from
// forgeax_view::common; shadow map + comparison sampler at view BG
// @binding(3..4) per shadow-mapping feat; Skylight 7 bindings merged after
// the Standard user region per D-5 round-4:
//
//   @group(0) @binding(0) view                       uniform   (see common.wgsl)
//   @group(1) @binding(0) material                   uniform   (baseColor vec4
//                                                               + metallic + roughness
//                                                               + 4 channel selectors f32
//                                                               + emissive vec3 + emissiveIntensity
//                                                               + uv/alpha/specularColor = 104 B)
//   @group(1) @binding(1) baseColorTexture_sampler           sampler
//   @group(1) @binding(2) baseColorTexture           texture_2d<f32>
//   @group(1) @binding(3) metallicRoughnessTexture_sampler   sampler
//   @group(1) @binding(4) metallicRoughnessTexture   texture_2d<f32>
//   @group(1) @binding(5) normalTexture_sampler              sampler
//   @group(1) @binding(6) normalTexture              texture_2d<f32>
//   @group(1) @binding(9..15) Skylight (irradiance / prefilter / brdfLut +
//                              samplers) + skylight uniform (intensity)
//   @group(2) @binding(0) meshes                     storage   (worldFromLocal mat4
//                                                               + normalMatrix mat3,
//                                                               see common.wgsl)
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance mat4;
//                                                               indexed by @builtin
//                                                               (instance_index);
//                                                               see common.wgsl)
//
// 20 entries fit within `device.limits.maxBindingsPerBindGroup` (default
// 1000 across all known WebGPU devices; chrome-beta + dawn confirmed via
// the runtime probe in createRenderer.ts -- requirements R-E acceptance
// gate). Adding more bindings requires raising the entry-count fixture in
// the M5-T04 acceptanceCheck readback assertion.
//
// Two-layer fail-fast for roughness=0 NaN avoidance (plan-strategy section
// 5.3 + AC-02 b/c):
//   layer 1: AssetRegistry.register fail-fast (M1 + M4 paramValues 3-tier)
//            returns 'asset-invalid-value' / 'material-param-type-mismatch'
//            before the payload reaches the GPU.
//   layer 2: shader internal `let a = max(material.roughness, 0.04); a = a * a;`
//            keeps D_GGX finite even if a producer somehow bypasses layer 1.
//
// Normal mapping (AC-05 + plan-strategy D-4): TBN basis built from
// per-vertex tangent (vec4 with handedness sign in .w) + interpolated
// world-space normal (consumed via mesh.normalMatrix from common.wgsl,
// plan-strategy D-5). RG-only tangent-space normal: sample.rg encodes
// (x,y) of the unit-length tangent normal, z is reconstructed via
// z = sqrt(1 - x^2 - y^2). Default 1x1 normal fallback texture is
// RG=(128,128) which decodes to tangent (0,0,1) -- zero perturbation when
// normalTexture is absent (host-side pipelineState.defaultNormalTextureView,
// distinct from the white fallback used by baseColor / metallicRoughness
// slots so a missing normal does not pollute the white-on-missing semantics
// of the other two slots). RG encoding also matches BC5 / RG normal maps
// and tolerates RGB normal maps (b is dropped, z is recomputed --
// equivalent for unit vectors).

// The MaterialParameters struct and its binding-0 declaration are generated
// from the root ParamSchema during composition. Keeping the ABI out of this
// template prevents a second handwritten interface from drifting from the
// runtime UBO writer.
@group(1) @binding(1) var baseColorTexture_sampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessTexture_sampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
@group(1) @binding(5) var normalTexture_sampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;
@group(1) @binding(9) var emissiveTexture_sampler : sampler;
@group(1) @binding(10) var emissiveTexture : texture_2d<f32>;
@group(1) @binding(11) var occlusionTexture_sampler : sampler;
@group(1) @binding(12) var occlusionTexture : texture_2d<f32>;
#ifdef TRANSMISSION_AVAILABLE
@group(1) @binding(13) var transmissionSampler : sampler;
@group(1) @binding(14) var transmissionTexture : texture_2d<f32>;
@group(1) @binding(15) var thicknessSampler : sampler;
@group(1) @binding(16) var thicknessTexture : texture_2d<f32>;
@group(1) @binding(24) var transmissionBackdropSampler : sampler;
@group(1) @binding(25) var transmissionBackdropTexture : texture_2d<f32>;
#endif
#ifdef CLEARCOAT_TEXTURE_AVAILABLE
@group(1) @binding(26) var clearcoatSampler : sampler;
@group(1) @binding(27) var clearcoatTexture : texture_2d<f32>;
#endif
#ifdef CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE
@group(1) @binding(28) var clearcoatRoughnessSampler : sampler;
@group(1) @binding(29) var clearcoatRoughnessTexture : texture_2d<f32>;
#endif
#ifdef CLEARCOAT_NORMAL_TEXTURE_AVAILABLE
@group(1) @binding(30) var clearcoatNormalSampler : sampler;
@group(1) @binding(31) var clearcoatNormalTexture : texture_2d<f32>;
#endif
#ifdef ANISOTROPY_TEXTURE_AVAILABLE
@group(1) @binding(32) var anisotropySampler : sampler;
@group(1) @binding(33) var anisotropyTexture : texture_2d<f32>;
#endif
#ifdef SHEEN_COLOR_TEXTURE_AVAILABLE
@group(1) @binding(34) var sheenColorSampler : sampler;
@group(1) @binding(35) var sheenColorTexture : texture_2d<f32>;
#endif
#ifdef SHEEN_ROUGHNESS_TEXTURE_AVAILABLE
@group(1) @binding(36) var sheenRoughnessSampler : sampler;
@group(1) @binding(37) var sheenRoughnessTexture : texture_2d<f32>;
#endif
#ifdef IRIDESCENCE_TEXTURE_AVAILABLE
@group(1) @binding(38) var iridescenceSampler : sampler;
@group(1) @binding(39) var iridescenceTexture : texture_2d<f32>;
#endif
#ifdef IRIDESCENCE_THICKNESS_TEXTURE_AVAILABLE
@group(1) @binding(40) var iridescenceThicknessSampler : sampler;
@group(1) @binding(41) var iridescenceThicknessTexture : texture_2d<f32>;
#endif
#ifdef SPECULAR_TEXTURE_AVAILABLE
@group(1) @binding(42) var specularTextureSampler : sampler;
@group(1) @binding(43) var specularTexture : texture_2d<f32>;
#endif
#ifdef SPECULAR_COLOR_TEXTURE_AVAILABLE
@group(1) @binding(44) var specularColorTextureSampler : sampler;
@group(1) @binding(45) var specularColorTexture : texture_2d<f32>;
#endif

// Naga reflection does not retain filtering usage through the generic shared
// helper. These compile-time-only witnesses retain the binding contract while
// every runtime material sample still goes through sampleMaterialTexture.
fn materialTextureFilteringWitness() {
  let base = baseColorTexture;
  let metallicRoughness = metallicRoughnessTexture;
  let normal = normalTexture;
  let emissive = emissiveTexture;
  let occlusion = occlusionTexture;
#ifdef CLEARCOAT_TEXTURE_AVAILABLE
  let clearcoat = clearcoatTexture;
#endif
#ifdef CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE
  let clearcoatRoughness = clearcoatRoughnessTexture;
#endif
#ifdef CLEARCOAT_NORMAL_TEXTURE_AVAILABLE
  let clearcoatNormal = clearcoatNormalTexture;
#endif
  let baseWitness = textureSample(base, baseColorTexture_sampler, vec2<f32>(0.0));
  let metallicRoughnessWitness = textureSample(metallicRoughness, metallicRoughnessTexture_sampler, vec2<f32>(0.0));
  let normalWitness = textureSample(normal, normalTexture_sampler, vec2<f32>(0.0));
  let emissiveWitness = textureSample(emissive, emissiveTexture_sampler, vec2<f32>(0.0));
  let occlusionWitness = textureSample(occlusion, occlusionTexture_sampler, vec2<f32>(0.0));
#ifdef CLEARCOAT_TEXTURE_AVAILABLE
  let clearcoatWitness = textureSample(clearcoat, clearcoatSampler, vec2<f32>(0.0));
#endif
#ifdef CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE
  let clearcoatRoughnessWitness = textureSample(clearcoatRoughness, clearcoatRoughnessSampler, vec2<f32>(0.0));
#endif
#ifdef CLEARCOAT_NORMAL_TEXTURE_AVAILABLE
  let clearcoatNormalWitness = textureSample(clearcoatNormal, clearcoatNormalSampler, vec2<f32>(0.0));
#endif
#ifdef ANISOTROPY_TEXTURE_AVAILABLE
  let anisotropyWitness = textureSample(anisotropyTexture, anisotropySampler, vec2<f32>(0.0));
#endif
#ifdef SHEEN_COLOR_TEXTURE_AVAILABLE
  let sheenColorWitness = textureSample(sheenColorTexture, sheenColorSampler, vec2<f32>(0.0));
#endif
#ifdef SHEEN_ROUGHNESS_TEXTURE_AVAILABLE
  let sheenRoughnessWitness = textureSample(sheenRoughnessTexture, sheenRoughnessSampler, vec2<f32>(0.0));
#endif
#ifdef IRIDESCENCE_TEXTURE_AVAILABLE
  let iridescenceWitness = textureSample(iridescenceTexture, iridescenceSampler, vec2<f32>(0.0));
#endif
#ifdef IRIDESCENCE_THICKNESS_TEXTURE_AVAILABLE
  let iridescenceThicknessWitness = textureSample(iridescenceThicknessTexture, iridescenceThicknessSampler, vec2<f32>(0.0));
#endif
#ifdef SPECULAR_TEXTURE_AVAILABLE
  let specularWeightWitness = textureSample(specularTexture, specularTextureSampler, vec2<f32>(0.0));
#endif
#ifdef SPECULAR_COLOR_TEXTURE_AVAILABLE
  let specularColorWitness = textureSample(specularColorTexture, specularColorTextureSampler, vec2<f32>(0.0));
#endif
#ifdef TRANSMISSION_AVAILABLE
  let transmission = transmissionTexture;
  let thickness = thicknessTexture;
  let transmissionWitness = textureSample(transmission, transmissionSampler, vec2<f32>(0.0));
  let thicknessWitness = textureSample(thickness, thicknessSampler, vec2<f32>(0.0));
#endif
}

// Skylight bindings merged into the PBR material BGL
// (feat-20260520-skylight-ibl-cubemap M3 / t48 round-4 amend per D-5
// round-4 REVISED). The round-2 stand-alone group 4 Skylight BGL collided
// with WebGPU's default maxBindGroups=4 in chrome-beta and blocked pbr-pl
// pipeline-layout creation; round-4 appends the 7 Skylight entries to the
// PBR material BindGroupLayout after the eight Standard texture pairs. The material BG factory
// (mergeSkylightIntoMaterialBgl in
// packages/runtime/src/ibl/skylight-bind-group.ts) extends the layout to
// merged entries; render-system-record assembles a single merged material
// BindGroup (no extra setBindGroup(4) call). Identity (default) resources
// produce ambient = 0; with a real Skylight, ibl_sampling helpers project
// the IBL irradiance + split-sum specular into `ambient` below.
struct SkylightUniforms {
  intensity : f32,
  // The former pad0/1/2 lanes now carry the linear-space ambient `color` tint
  // (downstream integration #4). Kept as three scalars (NOT vec3<f32>) so the
  // struct stays exactly 16 B: a vec3 has 16-byte alignment in std140 and
  // would push `color` to offset 16. The rotation vec4 follows at offset 16,
  // so the host writes one 32 B payload.
  colorR : f32,
  colorG : f32,
  colorB : f32,
  rotation : vec4<f32>,
};
@group(1) @binding(17) var irradianceMap        : texture_cube<f32>;
@group(1) @binding(18) var irradianceSampler    : sampler;
@group(1) @binding(19) var prefilterMap         : texture_cube<f32>;
@group(1) @binding(20) var prefilterSampler     : sampler;
@group(1) @binding(21) var brdfLut              : texture_2d<f32>;
@group(1) @binding(22) var brdfLutSampler       : sampler;
@group(1) @binding(23) var<uniform> skylight    : SkylightUniforms;

#ifdef PROBE_BLEND_AVAILABLE
// Optional consumer lane. The host provides the retained ProbeBlendRecord
// storage for the object selected by this draw. Keeping it in group(3)
// preserves the mesh/instance ownership of groups (2)/(3) without inventing a
// second probe bind group.
@group(3) @binding(1) var<storage, read> probeBlendRecords : array<vec4<f32>>;
#endif

// feat-20260612-hdrp-ssao M7 (round 2) D-B + D-C, scope-amend-webgl2-ubo:
// SSAO sampling lives on the HDRP unified BGL @group(2) alongside the
// cluster bindings (binding 7 = ssao texture, binding 8 = sampler). The
// intensity scalar is folded into `cluster_uniform.near_far_log.w` (the
// previously-unused std140 pad lane on @binding(6)) — declaring a
// dedicated UBO at @binding(9) overflows WebGL2's
// `max_uniform_buffers_per_shader_stage = 11` budget on rhi-wgpu's
// fallback path. Disabled SSAO path binds 1x1 white at @binding(7) + the
// host writes intensity=0 into the cluster pad lane, so the synthesis
// collapses identically.
#ifdef CLUSTER_FORWARD_AVAILABLE
@group(2) @binding(7) var ssaoBlurredTexture       : texture_2d<f32>;
@group(2) @binding(8) var ssaoBlurredSampler       : sampler;
#endif

struct VsIn  {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
  // MaterialAsset per-slot texCoord: reserve the canonical UV0-UV7 inputs.
  // Missing mesh sets are supplied by the pipeline's clamp-to-last aliases.
  @location(6) uv1     : vec2<f32>,
  @location(7) uv2     : vec2<f32>,
  @location(8) uv3     : vec2<f32>,
  @location(9) uv4     : vec2<f32>,
  @location(10) uv5    : vec2<f32>,
  @location(11) uv6    : vec2<f32>,
  @location(12) uv7    : vec2<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(13) color  : vec4<f32>,
#endif
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) worldTangent : vec4<f32>,
#ifdef TRANSMISSION_AVAILABLE
  // Keep mesh and instance storage vertex-only; transmission receives the
  // transform basis from the vertex stage below.
  @location(4) @interpolate(flat) transmissionBasis0 : vec4<f32>,
#else
  // WebGL2 exposes only inter-stage locations 0..14. Pack the object-space
  // Surface position with its cluster/CSM depth in one varying.
  @location(7) positionOSAndViewZ : vec4<f32>,
#endif
  // feat-city-glb multi-UV tiling: second UV set inter-stage varying. Uses the
  // previously-vacant @location(5) so @location(6)/(7) stay byte-stable with
  // the prior layout (CSM M5/w19).
  @location(5) uv1 : vec2<f32>,
  @location(8) uv2 : vec2<f32>,
  @location(9) uv3 : vec2<f32>,
  @location(10) uv4 : vec2<f32>,
  @location(11) uv5 : vec2<f32>,
  // UV6/UV7 share one vec4 slot so the transmission basis tail can stay
  // inside WebGL2's 14 user varying locations.
  @location(12) uv6And7 : vec4<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
  @location(6) ndc : vec4<f32>,  // NDC for HDRP cluster lookup; .w = transmission basis tail
  // feat-20260609-hdrp-cluster-fragment-ggx M4.5-followup: view-space z is
  // needed by ndc_position_to_cluster (slice index uses log-z mapping that
  // takes negative view_z, NOT NDC z which is [0,1]). Earlier `in.ndc.z`
  // pass through view_z slot collapsed every fragment to slice 0, so cube
  // surfaces -- whose cluster cells were unrelated to the floor's slice 0
  // hot zone -- received zero light. Forward view_z explicitly. M5 / w19:
  // also feeds CSM cascade selection in evalDirectional.
  // Surface position and clustered/CSM view depth share one varying so the
  // composed Standard shader stays within WebGL2's 14 inter-stage locations.
#ifdef TRANSMISSION_AVAILABLE
  @location(7) viewZ : f32,
  @location(13) @interpolate(flat) transmissionBasis1 : vec4<f32>,
#endif
};

// Light evaluators live in forgeax_pbr::lighting_directional +
// forgeax_pbr::lighting_punctual (M5 / T02). evalDirectional consumes the
// host's view UBO + shadowMap (LO 3.1.3 slope-scaled-bias 3x3 PCF;
// feat-20260520-directional-light-shadow-mapping byte-equivalent). evalPoint
// / evalSpot share evalPunctualBody (GGX specular + Lambertian diffuse +
// KHR_lights_punctual quartic range attenuation;
// feat-20260519-light-casters-point-spot-pbr M4 / w22 byte-equivalent).
// Charter P4: spot light is a thin cone-multiplier on top of the punctual
// body, point light is the body unchanged -- no magic-value collapse.

fn vs_main_impl(in : VsIn, meshIndex : u32, instanceIndex : u32) -> VsOut {
  // feat-20260604-instances-per-instance-transform-shader-group3-bin M1 / w4:
  // Entity world from meshes[0] — the @group(2) dynamic-offset window has
  // already been aimed at this entity's slot (render-system-record.ts:2996
  // setBindGroup(2, meshBindGroup, [i * MESH_PER_ENTITY_STRIDE])). Per-instance
  // local from instances[idx] — @group(3) is a flat per-instance buffer indexed
  // directly by instance_index (firstInstance=0, render-system-record.ts:2898).
  // Combine: entity_world * per_instance_local.
  let instanceLocal = instances[instanceIndex].localFromInstance;
  let entityWorld = meshes[meshIndex].worldFromLocal;
  let localToWorld = entityWorld * instanceLocal;
  let world = localToWorld * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
#ifndef TRANSMISSION_AVAILABLE
  out.positionOSAndViewZ = vec4<f32>(in.pos, sceneViewZ(out.clip, view.temporalProjection));
#endif
  out.worldPos = world.xyz;
  // Normal: derive the inverse-transpose from the world matrix columns. This
  // keeps non-uniform entity scale correct while avoiding the Mesh.normalMatrix
  // storage field whose mat3x3 layout is not consumed consistently by the GPU
  // path. The per-instance local transform remains uniform-scale-only, as it
  // was before this owner fix.
  let a = entityWorld[0].xyz;
  let b = entityWorld[1].xyz;
  let c = entityWorld[2].xyz;
  let cof0 = cross(b, c);
  let cof1 = cross(c, a);
  let cof2 = cross(a, b);
  let det = dot(a, cof0);
  let entityNormal = select(
    in.normal,
    (cof0 * in.normal.x + cof1 * in.normal.y + cof2 * in.normal.z) / det,
    abs(det) >= 1e-6,
  );
  out.worldNormal = normalize(entityNormal);
  // Tangent transformed by the combined entity*instance chain as a direction
  // (w=0); .w handedness preserved for bitangent reconstruction in fragment.
  let worldTangentXyz = normalize((entityWorld * instanceLocal * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
  out.worldTangent = vec4<f32>(worldTangentXyz, in.tangent.w);
  out.uv = in.uv;
  out.uv1 = in.uv1;
  out.uv2 = in.uv2;
  out.uv3 = in.uv3;
  out.uv4 = in.uv4;
  out.uv5 = in.uv5;
  out.uv6And7 = vec4<f32>(in.uv6, in.uv7);
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
#ifdef TRANSMISSION_AVAILABLE
  out.transmissionBasis0 = vec4<f32>(
    localToWorld[0].x,
    localToWorld[0].y,
    localToWorld[0].z,
    localToWorld[1].x,
  );
  out.transmissionBasis1 = vec4<f32>(
    localToWorld[1].y,
    localToWorld[1].z,
    localToWorld[2].x,
    localToWorld[2].y,
  );
#endif
  // feat-20260613-csm-cascaded-shadow-maps M5 / w19: the per-fragment
  // light-space position varying is gone; evalDirectional computes
  // per-cascade lightViewProj * worldPos in the fragment stage from
  // viewZ + worldPos.
  // NDC for HDRP cluster lookup (feat-20260609-hdrp-cluster-fragment-ggx M2 / w10).
  // Perspective divide on clip-space position; ndc.z retains depth-buffer value.
  let clipPos = out.clip;
  out.ndc = vec4(clipPos.xy / clipPos.w, clipPos.z / clipPos.w, localToWorld[2].z);
  // Keep the cluster depth exactly aligned with the CPU binner for both
  // perspective and off-axis orthographic projections.
#ifdef TRANSMISSION_AVAILABLE
  out.viewZ = sceneViewZ(clipPos, view.temporalProjection);
#endif
  return out;
}

fn standardViewZ(in : VsOut) -> f32 {
#ifdef TRANSMISSION_AVAILABLE
  return in.viewZ;
#else
  return in.positionOSAndViewZ.w;
#endif
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  return vs_main_impl(in, 0u, idx);
}

@vertex
fn vs_scene_index(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  // GPU-driven scene projection packs one Mesh row per visible candidate and
  // uses the identity instance row. The scene index therefore selects the
  // projected Mesh directly while retaining the Standard PBR varyings.
  return vs_main_impl(in, idx, 0u);
}

fn transformedMaterialUv(transform : vec4<f32>, metadata : vec4<f32>, in : VsOut) -> vec2<f32> {
  var source = in.uv;
  if (metadata.x >= 1.0) { source = in.uv1; }
  if (metadata.x >= 2.0) { source = in.uv2; }
  if (metadata.x >= 3.0) { source = in.uv3; }
  if (metadata.x >= 4.0) { source = in.uv4; }
  if (metadata.x >= 5.0) { source = in.uv5; }
  if (metadata.x >= 6.0) { source = in.uv6And7.xy; }
  if (metadata.x >= 7.0) { source = in.uv6And7.zw; }
  let scaled = source * transform.zw;
  let angle = metadata.y;
  let c = cos(angle);
  let s = sin(angle);
  return vec2<f32>(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c) + transform.xy;
}

fn materialVertexColor(in : VsOut) -> vec4<f32> {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color;
#else
  return vec4<f32>(1.0);
#endif
}

// Keep the cooked artifact content-addressable per declared capability set.
// Some capability axes only change an imported helper's resource surface; the
// witness makes that distinction explicit in the composed source as well, so
// two valid manifest keys can never alias one artifact hash.
fn standardVariantIdentity() -> f32 {
  var identity = 0.0;
#ifdef STORAGE_BUFFER_AVAILABLE
  identity = identity + 1.0;
#endif
#ifdef CLUSTER_FORWARD_AVAILABLE
  identity = identity + 2.0;
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  identity = identity + 4.0;
#endif
#ifdef PROBE_BLEND_AVAILABLE
  identity = identity + 8.0;
#endif
#ifdef EXTENDED_LIGHTING_AVAILABLE
  identity = identity + 16.0;
#endif
#ifdef TRANSMISSION_AVAILABLE
  identity = identity + 32.0;
#endif
#ifdef DIRECTIONAL_PCSS_AVAILABLE
  identity = identity + 64.0;
#endif
#ifdef PROJECTOR_AVAILABLE
  identity = identity + 128.0;
#endif
#ifdef REFLECTION_FALLBACK_AVAILABLE
  identity = identity + 256.0;
#endif
  return identity;
}

// Standard owns the lighting and pass policy; the selected Surface owns only
// the base facts exchanged through surface_v1.
fn evaluateStandardSurface(in : VsOut, frontFacing : bool) -> SurfaceData {
  let viewDirectionWS = normalize(view.cameraPos - in.worldPos);
#ifdef TRANSMISSION_AVAILABLE
  let positionOS = in.worldPos;
#else
  let positionOS = in.positionOSAndViewZ.xyz;
#endif
  return evaluate_surface(SurfaceInput(
    positionOS,
    in.worldPos,
    in.worldNormal,
    in.worldTangent,
    viewDirectionWS,
    in.uv,
    in.uv1,
    materialVertexColor(in),
    frontFacing,
  ));
}

// The renderer supplies the retained ProbeBlendRecord at the per-object
// consumer boundary. This helper deliberately accepts only diffuse inputs;
// Skylight/ReflectionProbe continue to own specular.
fn composeProbeDiffuse(
  shPreblend : array<vec4<f32>, 9>,
  localBlendFraction : f32,
  normal : vec3<f32>,
  skyIrradiance : vec3<f32>,
  kD : vec3<f32>,
  albedo : vec3<f32>,
  metallic : f32,
) -> vec3<f32> {
  return evaluateProbeDiffuse(shPreblend, localBlendFraction, normal, skyIrradiance, kD, albedo, metallic);
}

fn finiteScalar(value : f32, fallback : f32) -> f32 {
  let bounded = clamp(value, -65504.0, 65504.0);
  return select(fallback, bounded, value == value);
}

fn finiteColor(value : vec3<f32>, fallback : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    finiteScalar(value.x, fallback.x),
    finiteScalar(value.y, fallback.y),
    finiteScalar(value.z, fallback.z),
  );
}

// linearColorDomain: transparent source and destination values are blended
// before any display encoding. The fixed-function material blend state uses
// this same equation for the render target's declared linear domain.
fn blendLinearTransparent(
  source : vec3<f32>,
  destination : vec3<f32>,
  alpha : f32,
) -> vec3<f32> {
  return source * alpha + destination * (1.0 - alpha);
}

// linearHdrColorDomain: fs_main writes linear HDR when its target is HDR.
// toneStageInput: the value remains linear until the fullscreen tone stage.

fn alphaTestSurface(surface : SurfaceData) {
  if (surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold) {
    discard;
  }
}

struct StandardPbrOutput {
  @location(0) color : vec4<f32>,
#ifdef REFLECTION_FALLBACK_AVAILABLE
  // Linear HDR environment contribution from this same Standard BRDF callsite.
  // The detached producer names this second target S_fallback.
  @location(1) reflectionFallback : vec4<f32>,
#endif
};

@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  let _variantIdentity = standardVariantIdentity();
  let surface = evaluateStandardSurface(in, frontFacing);
  alphaTestSurface(surface);
  let alpha = surface.opacity;
  let albedo = surface.baseColor;
  let metallic = clamp(finiteScalar(surface.metallic, 0.0), 0.0, 1.0);
  let iblRoughness = clamp(finiteScalar(surface.roughness, 0.5), 0.04, 1.0);
  let a = iblRoughness * iblRoughness;
  let n = normalize(surface.normalWS);

  let v = normalize(view.cameraPos - in.worldPos);
  var specularColor = material.specularColor;
#ifdef SPECULAR_COLOR_TEXTURE_AVAILABLE
  let specularUv = transformedMaterialUv(
    material.specularColorTextureCoordinatesTransform,
    material.specularColorTextureCoordinatesMetadata,
    in,
  );
  specularColor = specularColor * sampleMaterialTexture(
    specularColorTexture,
    specularColorTextureSampler,
    specularUv,
    material.specularColorTextureCoordinatesMetadata.zw,
  ).rgb;
#endif
  var specularWeight = clamp(finiteScalar(material.specular, 1.0), 0.0, 1.0);
#ifdef SPECULAR_TEXTURE_AVAILABLE
  let specularWeightUv = transformedMaterialUv(
    material.specularTextureCoordinatesTransform,
    material.specularTextureCoordinatesMetadata,
    in,
  );
  specularWeight = specularWeight * sampleMaterialTexture(
    specularTexture,
    specularTextureSampler,
    specularWeightUv,
    material.specularTextureCoordinatesMetadata.zw,
  ).a;
#endif
  let safeIor = max(finiteScalar(material.ior, 1.5), 1.0);
  let dielectricF0 = pow((safeIor - 1.0) / (safeIor + 1.0), 2.0);
  var f0 = mix(vec3<f32>(dielectricF0) * specularColor * specularWeight, albedo, metallic);
  var physicalNormal = n;
#ifdef ANISOTROPY_AVAILABLE
  var anisotropyStrength = finiteScalar(material.anisotropyStrength, 0.0);
  var anisotropyRotation = finiteScalar(material.anisotropyRotation, 0.0);
  var anisotropyDirection = vec2<f32>(1.0, 0.0);
#ifdef ANISOTROPY_TEXTURE_AVAILABLE
  let anisotropyUv = transformedMaterialUv(
    material.anisotropyTextureCoordinatesTransform,
    material.anisotropyTextureCoordinatesMetadata,
    in,
  );
  let anisotropySample = sampleMaterialTexture(
    anisotropyTexture,
    anisotropySampler,
    anisotropyUv,
    material.anisotropyTextureCoordinatesMetadata.zw,
  );
  let encodedAnisotropyDirection = 2.0 * anisotropySample.rg - vec2<f32>(1.0, 1.0);
  if (dot(encodedAnisotropyDirection, encodedAnisotropyDirection) >= 1e-6) {
    anisotropyDirection = normalize(encodedAnisotropyDirection);
  }
  anisotropyStrength = anisotropyStrength * anisotropySample.b;
#endif
  physicalNormal = evaluateAnisotropicNormal(
    n,
    in.worldTangent,
    anisotropyStrength,
    anisotropyRotation,
    anisotropyDirection,
  );
#endif
#ifdef IRIDESCENCE_AVAILABLE
  var iridescenceStrength = finiteScalar(material.iridescence, 0.0);
  var iridescenceThicknessFactor = 1.0;
#ifdef IRIDESCENCE_TEXTURE_AVAILABLE
  let iridescenceUv = transformedMaterialUv(
    material.iridescenceTextureCoordinatesTransform,
    material.iridescenceTextureCoordinatesMetadata,
    in,
  );
  let iridescenceSample = sampleMaterialTexture(
    iridescenceTexture,
    iridescenceSampler,
    iridescenceUv,
    material.iridescenceTextureCoordinatesMetadata.zw,
  );
  iridescenceStrength = iridescenceStrength * iridescenceSample.r;
#endif
#ifdef IRIDESCENCE_THICKNESS_TEXTURE_AVAILABLE
  let iridescenceThicknessUv = transformedMaterialUv(
    material.iridescenceThicknessTextureCoordinatesTransform,
    material.iridescenceThicknessTextureCoordinatesMetadata,
    in,
  );
  let iridescenceThicknessSample = sampleMaterialTexture(
    iridescenceThicknessTexture,
    iridescenceThicknessSampler,
    iridescenceThicknessUv,
    material.iridescenceThicknessTextureCoordinatesMetadata.zw,
  );
  iridescenceThicknessFactor = clamp(iridescenceThicknessSample.g, 0.0, 1.0);
#endif
  let filmThickness = mix(
    finiteScalar(material.iridescenceThicknessMinimum, 100.0),
    finiteScalar(material.iridescenceThicknessMaximum, 400.0),
    iridescenceThicknessFactor,
  );
  f0 = evaluateIridescenceFresnel(
    f0,
    iridescenceStrength,
    finiteScalar(material.iridescenceIor, 1.3),
    filmThickness,
  );
#endif
  var diffuseAlbedo = albedo;
#ifdef TRANSMISSION_AVAILABLE
  let transmissionUv = transformedMaterialUv(
    material.transmissionTextureCoordinatesTransform,
    material.transmissionTextureCoordinatesMetadata,
    in,
  );
  let thicknessUv = transformedMaterialUv(
    material.thicknessTextureCoordinatesTransform,
    material.thicknessTextureCoordinatesMetadata,
    in,
  );
  let transmissionSample = sampleMaterialTexture(
    transmissionTexture,
    transmissionSampler,
    transmissionUv,
    material.transmissionTextureCoordinatesMetadata.zw,
  ).r;
  let thicknessSample = sampleMaterialTexture(
    thicknessTexture,
    thicknessSampler,
    thicknessUv,
    material.thicknessTextureCoordinatesMetadata.zw,
  ).g;
  let transmissionFactor = clamp(
    finiteScalar(material.transmission, 0.0) * finiteScalar(transmissionSample, 1.0),
    0.0,
    1.0,
  );
  let viewDot = finiteScalar(dot(n, v), 0.0);
  let refractionFromInside = viewDot < 0.0;
  let refractionNormal = select(n, -n, refractionFromInside);
  let refractionEta = select(1.0 / safeIor, safeIor, refractionFromInside);
  let incident = -v;
  let refracted = refract(incident, refractionNormal, refractionEta);
  let refractedLengthSquared = dot(refracted, refracted);
  let viewCos = clamp(abs(viewDot), 0.0, 1.0);
  let fresnel = clamp(f_schlick(viewCos, vec3<f32>(dielectricF0)).x, 0.0, 1.0);
  // `refract` returns the zero vector for total internal reflection. Keep the
  // reflection/IBL term above authoritative and remove transmission energy
  // instead of sampling and adding a second reflected environment.
  let transmittedEnergy = select(
    0.0,
    transmissionFactor * (1.0 - metallic) * (1.0 - fresnel),
    refractedLengthSquared > 1e-6,
  );
  diffuseAlbedo = albedo * (1.0 - transmittedEnergy);
#endif
  // Ambient (IBL) + 1 + N + N accumulation
  // (feat-20260520-skylight-ibl-cubemap M3 / t48 +
  //  feat-20260520-directional-light-shadow-mapping +
  //  feat-20260518-pbr-direct-lighting-mvp Finding 4):
  //
  //   color = ambient(IBL) + directional(shadowed) + sum(point) + sum(spot)
  //
  // When the host Skylight bind group provides default-zero resources the IBL
  // helpers sample to vec3(0) and ambient = 0, so the shader falls through to
  // direct lighting naturally (zero contribution, no branch, no #if guard).
  //
  // sampleIblDiffuse / sampleIblSpecular are imported from
  // forgeax_pbr::ibl_sampling (ibl-sampling.wgsl) and take the
  // @group(1) @binding(7..13) Skylight resources as function arguments
  // -- the runtime helper module is zero-binding so the host owns the
  // binding layout (round-4 amend: Skylight merged into material BGL).
  // `material.roughness` is the unsquared scalar; `a` above is the
  // alpha*alpha form used by direct-light D_GGX, which is wrong for the
  // split-sum mip lookup, so we re-derive the post-shader-clamp roughness
  // here (matches sampleIblSpecular's `mip = roughness * 4.0` expectation).
  //
  // Direct lights (1 + N + N): one directional + N point + N spot, summed
  // sequentially. LIGHT_ARRAY_MAX_SLOTS = 4 host-side bounds the loop trip
  // counts. GGX BRDF helpers (d_ggx / v_smith / f_schlick from
  // forgeax_pbr::brdf) run inside each evalDirectional / evalPoint / evalSpot
  // so all three light types share the same microfacet specular + Lambertian
  // diffuse form. The directional path additionally projects worldPos
  // through the per-cascade light-space matrix in the fragment stage for
  // shadow-map PCF lookup (CSM, feat-20260613).
  let kD = (vec3<f32>(1.0) - f_schlick(max(dot(physicalNormal, v), 0.0), f0)) * (1.0 - metallic);
  var coatRoughness = 0.04;
  var coatAlpha = coatRoughness * coatRoughness;
  var coatF = vec3<f32>(0.0);
#ifdef CLEARCOAT_AVAILABLE
  coatRoughness = max(finiteScalar(material.clearcoatRoughness, 0.04), 0.04);
  coatAlpha = coatRoughness * coatRoughness;
  coatF = f_schlick(max(dot(physicalNormal, v), 0.0), vec3<f32>(0.04)) *
    clamp(finiteScalar(material.clearcoat, 0.0), 0.0, 1.0);
#endif
  var irradiance = vec3<f32>(0.0);
  var specularIbl = vec3<f32>(0.0);
  if (skylight.intensity < 0.0) {
    // A negative intensity is the renderer-owned probe sentinel. The four
    // color/rotation lanes carry the selected probe center and half extents;
    // ordinary Skylight resources remain unchanged, preserving the ABI.
    specularIbl = sampleReflectionProbeSpecular(
      physicalNormal, v, iblRoughness, f0, in.worldPos,
      vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB),
      skylight.rotation.xyz, vec4<f32>(0.0, 0.0, 0.0, 1.0),
      prefilterMap, prefilterSampler, brdfLut, brdfLutSampler,
    );
  } else {
    irradiance = sampleIblDiffuse(physicalNormal, skylight.rotation, irradianceMap, irradianceSampler);
    specularIbl = sampleIblSpecular(
      physicalNormal, v, iblRoughness, f0,
      skylight.rotation,
      prefilterMap, prefilterSampler, brdfLut, brdfLutSampler,
    );
  }
  let ao = surface.occlusion;
  // feat-20260612-hdrp-ssao M7 round-2: `var` (mutable) so the
  // CLUSTER_FORWARD_AVAILABLE branch below can `ambient *=` the SSAO
  // factor. The non-HDRP path leaves ambient untouched.
  let skyColor = vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB);
  let skyFactor = skyColor * skylight.intensity;
  var reflectionFallback = specularIbl * (vec3<f32>(1.0) - coatF);
  var ambient = (kD * irradiance * diffuseAlbedo + specularIbl) *
    (vec3<f32>(1.0) - coatF);
#ifdef PROBE_BLEND_AVAILABLE
  // group(3) is the per-object bind group; record zero is the object selected
  // by this draw, independent of instance count.
  let probeShPreblend = array<vec4<f32>, 9>(
    probeBlendRecords[1], probeBlendRecords[2], probeBlendRecords[3],
    probeBlendRecords[4], probeBlendRecords[5], probeBlendRecords[6],
    probeBlendRecords[7], probeBlendRecords[8], probeBlendRecords[9],
  );
  let probeLocalBlendFraction = probeBlendRecords[0].z;
  let probeDiffuseK = kD / max(vec3<f32>(1.0 - metallic), vec3<f32>(0.0001));
  let probeDiffuse = composeProbeDiffuse(probeShPreblend,
    probeLocalBlendFraction,
    physicalNormal,
    irradiance * skyFactor,
    probeDiffuseK,
    diffuseAlbedo,
    metallic,
  );
  ambient = (probeDiffuse + specularIbl * skyFactor) *
    (vec3<f32>(1.0) - coatF);
#endif
#ifdef PROBE_BLEND_AVAILABLE
  ambient = ambient * ao;
#else
  // In the regular Skylight path tint/intensity are applied after sampling.
  // In the probe-sentinel path intensity is encoded as -(probeIntensity + 1),
  // so decode only the non-negative payload and keep zero-intensity probes
  // distinct from an absent Skylight.
  if (skylight.intensity < 0.0) {
    let environmentScale = max(-skylight.intensity - 1.0, 0.0) * ao;
    ambient = ambient * environmentScale;
    reflectionFallback = reflectionFallback * environmentScale;
  } else {
    let environmentScale = skyColor * skylight.intensity * ao;
    ambient = ambient * environmentScale;
    reflectionFallback = reflectionFallback * environmentScale;
  }
#endif
#ifdef CLUSTER_FORWARD_AVAILABLE
  // feat-20260612-hdrp-ssao M2 round-1 + M7 round-2 (plan-strategy D-7 + D-B + D-C):
  // SSAO ambient synthesis. Reads the half-res R8 `ssaoBlurredTexture` from
  // the ssao-blur pass (HDRP unified BGL @group(2) @binding(7..9)). The host
  // always binds those slots: when SSAO is disabled, binding 7 receives a
  // 1x1 white fallback (AO=1.0) and binding 9 receives a zero-intensity
  // uniform — `mix(1.0, ssao*ao, 0.0) = 1.0` so ambient collapses to the
  // round-1 baseline (no PSO recompile across the toggle).
  //
  // Sampling uses the screen-space NDC -> [0,1] uv; we recover it from the
  // clip-space xy that the vertex stage already emits via in.ndc.xy.
  let ssaoUv = in.ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  let ssaoFactor = textureSample(ssaoBlurredTexture, ssaoBlurredSampler, ssaoUv).r;
  // scope-amend-webgl2-ubo: intensity packed into cluster_uniform.near_far_log.w.
  let ssaoIntensity = get_ssao_intensity();
  ambient *= mix(1.0, ssaoFactor * ao, ssaoIntensity);
  let ssaoScale = mix(1.0, ssaoFactor * ao, ssaoIntensity);
  reflectionFallback *= ssaoScale;
#endif
  var color = ambient;
#ifdef TRANSMISSION_AVAILABLE
  let screenUv = in.ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  // Read the affine basis forwarded by the vertex stage. This keeps the
  // fragment path within the inter-stage location budget and preserves the
  // scene-index vertex entry used by the GPU-driven lane.
  let localToWorld0 = in.transmissionBasis0.xyz;
  let localToWorld1 = vec3<f32>(
    in.transmissionBasis0.w,
    in.transmissionBasis1.x,
    in.transmissionBasis1.y,
  );
  let localToWorld2 = vec3<f32>(
    in.transmissionBasis1.z,
    in.transmissionBasis1.w,
    in.ndc.w,
  );
  let inverseCofactor0 = cross(localToWorld1, localToWorld2);
  let inverseCofactor1 = cross(localToWorld2, localToWorld0);
  let inverseCofactor2 = cross(localToWorld0, localToWorld1);
  let localToWorldDet = dot(localToWorld0, inverseCofactor0);
  let safeLocalToWorldDet = select(1.0, localToWorldDet, abs(localToWorldDet) >= 1e-6);
  let worldToLocal0 = vec3<f32>(
    inverseCofactor0.x,
    inverseCofactor1.x,
    inverseCofactor2.x,
  ) / safeLocalToWorldDet;
  let worldToLocal1 = vec3<f32>(
    inverseCofactor0.y,
    inverseCofactor1.y,
    inverseCofactor2.y,
  ) / safeLocalToWorldDet;
  let worldToLocal2 = vec3<f32>(
    inverseCofactor0.z,
    inverseCofactor1.z,
    inverseCofactor2.z,
  ) / safeLocalToWorldDet;
  let refractedLocal = normalize(
    worldToLocal0 * refracted.x +
      worldToLocal1 * refracted.y +
      worldToLocal2 * refracted.z,
  );
  let worldRefractedDirection =
    localToWorld0 * refractedLocal.x +
    localToWorld1 * refractedLocal.y +
    localToWorld2 * refractedLocal.z;
  let worldThickness = max(
    finiteScalar(material.thickness, 0.0) * length(worldRefractedDirection) *
      finiteScalar(thicknessSample, 1.0),
    0.0,
  );
  let refractedUv = screenUv + (refracted.xy - incident.xy) * worldThickness * 0.25;
  let guardBand = 0.02;
  let insideGuardBand = all(refractedUv >= vec2<f32>(guardBand)) &&
    all(refractedUv <= vec2<f32>(1.0 - guardBand));
  let backdropMipCount = textureNumLevels(transmissionBackdropTexture);
  let backdropMaxLod = max(f32(backdropMipCount) - 1.0, 0.0);
  let backdropLod = clamp(iblRoughness * iblRoughness * backdropMaxLod, 0.0, backdropMaxLod);
  let unrefractedBackdrop = textureSampleLevel(
    transmissionBackdropTexture,
    transmissionBackdropSampler,
    clamp(screenUv, vec2<f32>(0.0), vec2<f32>(1.0)),
    backdropLod,
  ).rgb;
  var transmittedBackdrop = unrefractedBackdrop;
  if (refractedLengthSquared > 1e-6 && insideGuardBand) {
    transmittedBackdrop = textureSampleLevel(
      transmissionBackdropTexture,
      transmissionBackdropSampler,
      clamp(refractedUv, vec2<f32>(0.0), vec2<f32>(1.0)),
      backdropLod,
    ).rgb;
  }
  let safeAttenuationColor = clamp(
    finiteColor(material.attenuationColor, vec3<f32>(1.0)),
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
  let safeAttenuationDistance = max(finiteScalar(material.attenuationDistance, 0.0), 0.0);
  let attenuationExponent = worldThickness / max(safeAttenuationDistance, 1e-6);
  let beerAttenuation = select(
    vec3<f32>(1.0),
    pow(safeAttenuationColor, vec3<f32>(attenuationExponent)),
    safeAttenuationDistance > 1e-6 && worldThickness > 0.0,
  );
  color = color + finiteColor(transmittedBackdrop, vec3<f32>(0.0)) *
    transmittedEnergy * beerAttenuation;
#endif
  let directionalShadow = evalDirectionalShadowFactor(
    physicalNormal,
    in.worldPos,
    standardViewZ(in),
  );
  let directionalBase = evalDirectionalNoShadow(physicalNormal, v, diffuseAlbedo, metallic, a, f0);
  color = color + directionalShadow * directionalBase;
#ifdef CLUSTER_FORWARD_AVAILABLE
  // NDC from vertex shader (perspective-divided clip-space, interpolated).
  // view_z: NDC depth for cluster Z-slice lookup.
  color = color + evaluateStandardClusterLights(
    in.ndc.xyz, standardViewZ(in), in.worldPos, physicalNormal, v,
    diffuseAlbedo, metallic, a, f0, false,
  );
#endif // CLUSTER_FORWARD_AVAILABLE
  // Emissive is part of the lower-energy stack and is attenuated by the
  // topcoat just like diffuse/specular radiance.
  color = color + surface.emissive;
#ifdef SHEEN_AVAILABLE
  var sheenColor = material.sheenColor;
  var sheenRoughnessFactor = 1.0;
#ifdef SHEEN_COLOR_TEXTURE_AVAILABLE
  let sheenColorUv = transformedMaterialUv(
    material.sheenColorTextureCoordinatesTransform,
    material.sheenColorTextureCoordinatesMetadata,
    in,
  );
  sheenColor = sheenColor * sampleMaterialTexture(
    sheenColorTexture,
    sheenColorSampler,
    sheenColorUv,
    material.sheenColorTextureCoordinatesMetadata.zw,
  ).rgb;
#endif
#ifdef SHEEN_ROUGHNESS_TEXTURE_AVAILABLE
  let sheenRoughnessUv = transformedMaterialUv(
    material.sheenRoughnessTextureCoordinatesTransform,
    material.sheenRoughnessTextureCoordinatesMetadata,
    in,
  );
  sheenRoughnessFactor = sampleMaterialTexture(
    sheenRoughnessTexture,
    sheenRoughnessSampler,
    sheenRoughnessUv,
    material.sheenRoughnessTextureCoordinatesMetadata.zw,
  ).a;
#endif
  let sheenRoughness = clamp(
    finiteScalar(material.sheenRoughness, 0.0) * sheenRoughnessFactor,
    0.0,
    1.0,
  );
  color = evaluateSheenLayer(color, sheenColor, sheenRoughness, dot(n, v));
#endif
#ifdef CLEARCOAT_AVAILABLE
  var clearcoatFactor = clamp(material.clearcoat, 0.0, 1.0);
#ifdef CLEARCOAT_TEXTURE_AVAILABLE
  let clearcoatUv = transformedMaterialUv(material.clearcoatTextureCoordinatesTransform, material.clearcoatTextureCoordinatesMetadata, in);
  clearcoatFactor = clamp(
    material.clearcoat * sampleMaterialTexture(
      clearcoatTexture,
      clearcoatSampler,
      clearcoatUv,
      material.clearcoatTextureCoordinatesMetadata.zw,
    ).r,
    0.0,
    1.0,
  );
#endif
  var clearcoatRoughnessValue = clamp(max(material.clearcoatRoughness, 0.04), 0.04, 1.0);
#ifdef CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE
  let clearcoatRoughnessUv = transformedMaterialUv(material.clearcoatRoughnessTextureCoordinatesTransform, material.clearcoatRoughnessTextureCoordinatesMetadata, in);
  clearcoatRoughnessValue = clamp(
    max(material.clearcoatRoughness, 0.04) * sampleMaterialTexture(
      clearcoatRoughnessTexture,
      clearcoatRoughnessSampler,
      clearcoatRoughnessUv,
      material.clearcoatRoughnessTextureCoordinatesMetadata.zw,
    ).g,
    0.04,
    1.0,
  );
#endif
  var clearcoatNormalValue = in.worldNormal;
#ifdef CLEARCOAT_NORMAL_TEXTURE_AVAILABLE
  let clearcoatNormalUv = transformedMaterialUv(material.clearcoatNormalTextureCoordinatesTransform, material.clearcoatNormalTextureCoordinatesMetadata, in);
  clearcoatNormalValue = applyTBN(
    in.worldNormal,
    in.worldTangent,
    scaleTangentSpaceNormal(
      decodeTangentSpaceNormalRg(sampleMaterialTexture(
        clearcoatNormalTexture,
        clearcoatNormalSampler,
        clearcoatNormalUv,
        material.clearcoatNormalTextureCoordinatesMetadata.zw,
      ).rg),
      material.clearcoatNormalScale,
    ),
  );
#endif
  var clearcoatIbl = vec3<f32>(0.0);
  if (skylight.intensity < 0.0) {
    clearcoatIbl = sampleReflectionProbeSpecular(
      clearcoatNormalValue,
      v,
      clearcoatRoughnessValue,
      vec3<f32>(0.04),
      in.worldPos,
      vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB),
      skylight.rotation.xyz,
      vec4<f32>(0.0, 0.0, 0.0, 1.0),
      prefilterMap,
      prefilterSampler,
      brdfLut,
      brdfLutSampler,
    );
  } else {
    clearcoatIbl = sampleIblSpecular(
      clearcoatNormalValue,
      v,
      clearcoatRoughnessValue,
      vec3<f32>(0.04),
      skylight.rotation,
      prefilterMap,
      prefilterSampler,
      brdfLut,
      brdfLutSampler,
    );
  }
  let clearcoatAlpha = clearcoatRoughnessValue * clearcoatRoughnessValue;
  let clearcoatDirect = directionalShadow * evalDirectionalNoShadow(
    clearcoatNormalValue,
    v,
    vec3<f32>(0.0),
    1.0,
    clearcoatAlpha,
    vec3<f32>(0.04),
  );
  let directionalClearcoat = clearcoatDirect;
  let clearcoatContribution = clearcoatIbl * clearcoatFactor;
  var clearcoatEnvironment = clearcoatIbl * skyColor * skylight.intensity;
  if (skylight.intensity < 0.0) {
    clearcoatEnvironment = clearcoatIbl;
  }
  color = evaluateClearcoatLayer(
    color,
    clearcoatEnvironment + directionalClearcoat,
    dot(clearcoatNormalValue, v),
    clearcoatFactor,
  );
  reflectionFallback = reflectionFallback + clearcoatContribution;
#endif
  var output : StandardPbrOutput;
  output.color = vec4<f32>(color, alpha);
#ifdef REFLECTION_FALLBACK_AVAILABLE
  output.reflectionFallback = vec4<f32>(reflectionFallback, 1.0);
#endif
  return output;
}

// ── G-buffer output struct (feat-20260612-hdrp-deferred-shading M2 / w12) ──
//
// D-8: g-buffer fragment lives in default-standard-pbr as an additional entry
// point (`fs_gbuffer`), NOT a separate MaterialShader. This aligns with D-1
// (concept count compression — no new shader id for the same material).
//
// D-2 / requirements §3.2 g-buffer schema:
//   @location(0) RT0 = normal.rgb + roughness.a → rgba16f
//   @location(1) RT1 = albedo.rgb + metallic.a → rgba8unorm
//   @location(2) RT2 = emissive.rgb + ao.a → rgba16f

struct GBufferOutput {
  @location(0) normal_roughness : vec4<f32>,
  @location(1) albedo_metallic  : vec4<f32>,
  @location(2) emissive_ao      : vec4<f32>,
};

/// Deferred g-buffer fragment entry: writes material properties (normal,
/// albedo, roughness, metallic, emissive, ao) to a 3-RT g-buffer for the
/// deferred lighting pass to decode. Lighting evaluation is deferred — this
/// entry does NOT compute GGX / directional / cluster lights.
///
/// Shares the same vertex shader `vs_main` and the same material UBO / texture
/// bindings as `fs_main`; only the fragment output differs. The HDRP
/// pipeline's g-buffer render pass binds this entry point via the shader's
/// multi-entry support (passKind='deferred' selects `fs_gbuffer`).
@fragment
fn fs_gbuffer(in : VsOut, @builtin(front_facing) frontFacing : bool) -> GBufferOutput {
  let surface = evaluateStandardSurface(in, frontFacing);
  alphaTestSurface(surface);
  let albedo = surface.baseColor;
  let metallic = clamp(surface.metallic, 0.0, 1.0);
  let roughness = clamp(surface.roughness, 0.04, 1.0);
  let n = normalize(surface.normalWS);

  var out : GBufferOutput;
  out.normal_roughness = vec4<f32>(n * 0.5 + 0.5, roughness);
  out.albedo_metallic  = vec4<f32>(albedo, metallic);
  out.emissive_ao      = vec4<f32>(surface.emissive, surface.occlusion);
  return out;
}

struct TemporalVsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) uv1 : vec2<f32>,
  @location(2) uv2 : vec2<f32>,
  @location(3) uv3 : vec2<f32>,
  @location(4) uv4 : vec2<f32>,
  @location(5) uv5 : vec2<f32>,
  @location(6) uv6 : vec2<f32>,
  @location(7) uv7 : vec2<f32>,
  @location(8) @interpolate(perspective) currentClip : vec4<f32>,
  @location(9) @interpolate(perspective) previousClip : vec4<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
};

@vertex
fn vs_temporal(in : VsIn, @builtin(instance_index) idx : u32) -> TemporalVsOut {
  let currentWorld = meshes[0].worldFromLocal *
    instances[idx].localFromInstance * vec4<f32>(in.pos, 1.0);
  var previousWorld = currentWorld;
#if STORAGE_BUFFER_AVAILABLE == true
  previousWorld = meshes[0].previousWorldFromLocal *
    instances[idx].previousLocalFromInstance * vec4<f32>(in.pos, 1.0);
#endif
  var out : TemporalVsOut;
  out.currentClip = view.temporalCurrentViewProj * currentWorld;
  out.clip = out.currentClip;
  out.previousClip = view.temporalPreviousViewProj * previousWorld;
  out.uv = in.uv;
  out.uv1 = in.uv1;
  out.uv2 = in.uv2;
  out.uv3 = in.uv3;
  out.uv4 = in.uv4;
  out.uv5 = in.uv5;
  out.uv6 = in.uv6;
  out.uv7 = in.uv7;
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
  return out;
}

fn temporalVertexAlpha(in : TemporalVsOut) -> f32 {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color.a;
#else
  return 1.0;
#endif
}

@fragment
fn fs_temporal(in : TemporalVsOut) -> @location(0) vec4<f32> {
  var reactive = 0.0;
#if STORAGE_BUFFER_AVAILABLE == true
  reactive = meshes[0].temporal.x;
#endif
  return projectPbrSceneTemporal(
    material.baseColor.a * temporalVertexAlpha(in),
    material.alphaCutoff,
    baseColorTexture,
    baseColorTexture_sampler,
    material.baseColorTextureCoordinatesTransform,
    material.baseColorTextureCoordinatesMetadata,
    in.currentClip,
    in.previousClip,
    view.temporalProjection,
    reactive,
    in.uv, in.uv1, in.uv2, in.uv3,
    in.uv4, in.uv5, in.uv6, in.uv7,
  );
}
