#pragma material_slot surface
#import forgeax_material::slot::surface::{evaluate_surface}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_view::common::{View, Mesh, InstanceData, view, meshes, instances, shadowMap, shadowSampler, sampleMaterialTexture}
#import forgeax_scene_temporal::{sceneViewZ}
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{spotModifierSampler, iesProfileTexture, cookieTexture, cookieMatrices}
#endif
#import forgeax_pbr::temporal::{projectPbrSceneTemporal}
#import forgeax_pbr::brdf::{f_schlick, v_smith, d_ggx}
#import forgeax_pbr::ibl_sampling::{sampleIblDiffuse, sampleIblSpecular, sampleReflectionProbeSpecular}
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

#define_import_path forgeax_material::pbr-skin
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE
#pragma variant_axis VERTEX_COLOR_AVAILABLE
#pragma variant_axis PROBE_BLEND_AVAILABLE
#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE
#pragma variant_axis TRANSMISSION_AVAILABLE
#pragma variant_axis DIRECTIONAL_PCSS_AVAILABLE

#ifdef PROBE_BLEND_AVAILABLE
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
#endif

// @forgeax/engine-shader - default-standard-pbr-skin.wgsl
// (feat-20260523-skin-skeleton-animation M3 / T-29).
//
// Engine-shipped default standard PBR material shader with GPU skinning,
// registered under the reserved path identifier `forgeax::pbr-skin`
// (plan-strategy D-3). Fragment stage is byte-for-byte identical to
// default-standard-pbr.wgsl — the two shaders share the same PBR/IBL/TBN/
// lighting helpers via #import. The vertex stage adds 4-bone weighted
// skinning before the worldFromLocal transform.
//
// Bindings (4 BG layout slots; @group(0) View / @group(1) Material+Texture
// / @group(2) Meshes+Palette — identical to default-standard-pbr except
// @group(2)@binding(1) adds the skin palette storage buffer):
//
//   @group(0) @binding(0) view                       uniform   (see common.wgsl)
//   @group(1) @binding(0) material                   uniform
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
//   @group(2) @binding(1) palette                    storage   (array of joint
//                                                               skinning mat4x4,
//                                                               CPU-precomputed
//                                                               world * IBM)
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance
//                                                               mat4; see
//                                                               common.wgsl —
//                                                               preventive
//                                                               structural
//                                                               alignment:
//                                                               SkinInstances-
//                                                               CoexistForbidden
//                                                               blocks skin +
//                                                               instances, so
//                                                               instances[idx]
//                                                               = I identity)
//
// Skinning formula (plan-strategy D-3 / D-3a):
//   world_pos  = Sum(w_i * palette[base + skinIndex[i]] * local_pos)
//   world_norm = transpose(inverse(mat3x3(skin_matrix))) * local_normal
// 4 joints max; weighted sum of skinned positions from the palette buffer
// indexed by the per-vertex skinIndex vector.

// The MaterialParameters struct and its binding-0 declaration are generated
// from the root ParamSchema during material composition. Keeping the ABI out
// of this template prevents a second handwritten interface from drifting from
// the runtime UBO writer.
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

// Preserve filtering reflection for resources passed to the shared sampler.
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
#ifdef TRANSMISSION_AVAILABLE
  let transmission = transmissionTexture;
  let thickness = thicknessTexture;
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
  let transmissionWitness = textureSample(transmission, transmissionSampler, vec2<f32>(0.0));
  let thicknessWitness = textureSample(thickness, thicknessSampler, vec2<f32>(0.0));
#endif
}

struct SkylightUniforms {
  intensity : f32,
  // 16 B (WebGL2 / GLES 3.0 uniform-buffer 16-byte-multiple rule). The former
  // pad0/1/2 lanes now carry the linear-space ambient `color` tint
  // (downstream integration #4). Kept as three scalars (NOT vec3<f32>) so the
  // struct stays exactly 16 B -- a vec3 has 16-byte std140 alignment and would
  // grow the UBO to 32 B. Host writes `[intensity, colorR, colorG, colorB]`;
  // color defaults to white so the multiply is identity for intensity-only
  // callers.
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
@group(3) @binding(1) var<storage, read> probeBlendRecords : array<vec4<f32>>;
#endif

#if STORAGE_BUFFER_AVAILABLE == true
@group(2) @binding(1) var<storage, read> palette : array<mat4x4<f32>>;
@group(2) @binding(2) var<storage, read> previousPalette : array<mat4x4<f32>>;
#else
@group(2) @binding(1) var<uniform> palette : array<mat4x4<f32>, 255>;
@group(2) @binding(2) var<uniform> previousPalette : array<mat4x4<f32>, 255>;
#endif

struct VsIn  {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
  @location(4) skinIndex  : vec4<u32>,
  @location(5) skinWeight : vec4<f32>,
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
#ifdef TRANSMISSION_AVAILABLE
  @location(4) @interpolate(flat) transmissionBasis0 : vec4<f32>,
#else
  // WebGL2 exposes only inter-stage locations 0..14. Pack the object-space
  // Surface position with its cluster/CSM depth in one varying.
  @location(7) positionOSAndViewZ : vec4<f32>,
#endif
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) worldTangent : vec4<f32>,
  // feat-city-glb multi-UV tiling: second UV set varying at location 5
  // (parity with default-standard-pbr.wgsl).
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
  @location(6) ndc : vec4<f32>,
#ifdef TRANSMISSION_AVAILABLE
  @location(7) viewZ : f32,
  @location(13) @interpolate(flat) transmissionBasis1 : vec4<f32>,
#endif
};

fn vs_main_impl(in : VsIn, meshIndex : u32, instanceIndex : u32) -> VsOut {
  // 4-bone weighted skinning (plan-strategy D-3 / D-3a).
  // The host pre-computes each joint matrix as worldFromJoint * inverseBindMatrix
  // (CPU-side pre-multiplication, per D-4) and writes them into the palette
  // storage buffer. The BindGroup dynamic offset selects the per-entity slice
  // so palette[0] is the first joint of this draw.

  // Accumulate the weighted 4-joint skinning matrix: sum(w_i * M_i).
  // Each palette entry is a mat4x4<f32> (world * IBM per joint).
  // The host sets the BindGroup dynamic offset to (byteOffset / 64) so the
  // first palette entry visible to this draw is palette[0]. The shader
  // indexes into palette directly using the per-vertex skinIndex values.
  let skinMatrix = palette[in.skinIndex.x] * in.skinWeight.x +
    palette[in.skinIndex.y] * in.skinWeight.y +
    palette[in.skinIndex.z] * in.skinWeight.z +
    palette[in.skinIndex.w] * in.skinWeight.w;

  // glTF 2.0 sec.Skins Implementation Note: when a mesh node has a skin
  // property, the joint matrices already encode the global transform of each
  // joint relative to the scene root. The transform of the mesh node itself
  // must be ignored when rendering the skinned mesh.
  //
  // The host pre-computes palette[i] = jointWorld_i * IBM_i (full world-space
  // transform, including the entire ancestor chain via propagateTransforms).
  // skinnedLocal IS the world position -- no additional left-multiply by
  // meshes[0].worldFromLocal or instanceLocal is needed.
  //
  // This removes the implicit contract "Skin entity Transform.world must be
  // identity" -- a skin entity can be parented under any Transform chain and
  // the skinned mesh will rigidly follow via joint propagation alone.
  let skinnedLocal = skinMatrix * vec4<f32>(in.pos, 1.0);

  // Extract the upper-left 3x3 for normal/tangent transformation
  // (plan-strategy D-3a). WGSL mat4x4 columns are vec4:
  //   col0 = palette[i][0], col1 = palette[i][1], col2 = palette[i][2].
  // We sum the weighted columns across the 4 joints to build the 3x3.
  let m0 = skinMatrix[0].xyz;
  let m1 = skinMatrix[1].xyz;
  let m2 = skinMatrix[2].xyz;
  let skinNormal3x3 = mat3x3<f32>(m0, m1, m2);

  // world = skinnedLocal (position), no extra left-multiply --
  // palette = jointWorld * IBM is already full world-space.
  var out : VsOut;
  // Keep meshes[0] and instances bindings referenced so naga_oil does not
  // dead-code-eliminate the @group(2)@binding(0) and @group(3)@binding(0)
  // globals. The host-side BGL shape must remain compatible with non-skin
  // PBR pipeline layout (buildPbrSkinLayouts declares 2-entry mesh-array
  // slot + separate instances slot). Without these keep-alive references,
  // createRenderPipeline would fail at binding-count validation.
  _ = meshes[meshIndex].worldFromLocal;
  _ = instances[instanceIndex].localFromInstance;
  out.clip = view.worldViewProj * skinnedLocal;
#ifndef TRANSMISSION_AVAILABLE
  out.positionOSAndViewZ = vec4<f32>(in.pos, sceneViewZ(out.clip, view.temporalProjection));
#endif
  out.worldPos = skinnedLocal.xyz;
  out.worldNormal = normalize(skinNormal3x3 * in.normal);
  let worldTangentXyz = normalize(skinNormal3x3 * in.tangent.xyz);
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
  // Skin palette already contains the world-space transform. Forward its
  // affine basis so transmission does not reread Mesh/Instance storage in
  // the fragment stage.
  out.transmissionBasis0 = vec4<f32>(skinMatrix[0].xyz, skinMatrix[1].x);
  out.transmissionBasis1 = vec4<f32>(skinMatrix[1].y, skinMatrix[1].z, skinMatrix[2].x, skinMatrix[2].y);
#endif
  let clipPos = out.clip;
  out.ndc = vec4(clipPos.xy / clipPos.w, clipPos.z / clipPos.w, skinMatrix[2].z);
  // feat-20260613-csm-cascaded-shadow-maps M5 / w19: viewZ replaces the
  // prior light-space-position varying; evalDirectional picks the cascade
  // matrix per fragment from viewZ + worldPos.
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

// Keep the cooked skinned artifact content-addressable per declared
// capability set, including axes whose imported helper/resource surface is
// otherwise identical after lowering.
fn standardSkinVariantIdentity() -> f32 {
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
  return identity;
}

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

fn alphaTestSurface(surface : SurfaceData) {
  if (surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold) {
    discard;
  }
}

@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) -> @location(0) vec4<f32> {
  let _variantIdentity = standardSkinVariantIdentity();
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
  specularColor = specularColor * sampleMaterialTexture(
    specularColorTexture,
    specularColorTextureSampler,
    transformedMaterialUv(
      material.specularColorTextureCoordinatesTransform,
      material.specularColorTextureCoordinatesMetadata,
      in,
    ),
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
  let transmittedEnergy = select(
    0.0,
    transmissionFactor * (1.0 - metallic) * (1.0 - fresnel),
    refractedLengthSquared > 1e-6,
  );
  diffuseAlbedo = albedo * (1.0 - transmittedEnergy);
#endif
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
  let skyColor = vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB);
  let skyFactor = skyColor * skylight.intensity;
  var ambient = (kD * irradiance * diffuseAlbedo + specularIbl) *
    (vec3<f32>(1.0) - coatF);
#ifdef PROBE_BLEND_AVAILABLE
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
  if (skylight.intensity < 0.0) {
    let environmentScale = max(-skylight.intensity - 1.0, 0.0) * ao;
    ambient = ambient * environmentScale;
  } else {
    let environmentScale = skyColor * skylight.intensity * ao;
    ambient = ambient * environmentScale;
  }
#endif
  var color = ambient;
#ifdef TRANSMISSION_AVAILABLE
  let screenUv = in.ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
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
  color = color + surface.emissive;
  let directionalShadow = evalDirectionalShadowFactor(
    physicalNormal,
    in.worldPos,
    standardViewZ(in),
  );
  let directionalBase = evalDirectionalNoShadow(physicalNormal, v, diffuseAlbedo, metallic, a, f0);
  color = color + directionalShadow * directionalBase;
#ifdef CLUSTER_FORWARD_AVAILABLE
  color = color + evaluateStandardClusterLights(
    in.ndc.xyz, standardViewZ(in), in.worldPos, physicalNormal, v,
    diffuseAlbedo, metallic, a, f0, false,
  );
#endif // CLUSTER_FORWARD_AVAILABLE
#ifdef SHEEN_AVAILABLE
  var sheenColor = material.sheenColor;
  var sheenRoughnessFactor = 1.0;
#ifdef SHEEN_COLOR_TEXTURE_AVAILABLE
  sheenColor = sheenColor * sampleMaterialTexture(
    sheenColorTexture,
    sheenColorSampler,
    transformedMaterialUv(material.sheenColorTextureCoordinatesTransform, material.sheenColorTextureCoordinatesMetadata, in),
    material.sheenColorTextureCoordinatesMetadata.zw,
  ).rgb;
#endif
#ifdef SHEEN_ROUGHNESS_TEXTURE_AVAILABLE
  sheenRoughnessFactor = sampleMaterialTexture(
    sheenRoughnessTexture,
    sheenRoughnessSampler,
    transformedMaterialUv(material.sheenRoughnessTextureCoordinatesTransform, material.sheenRoughnessTextureCoordinatesMetadata, in),
    material.sheenRoughnessTextureCoordinatesMetadata.zw,
  ).a;
#endif
  let sheenRoughness = clamp(
    material.sheenRoughness * sheenRoughnessFactor,
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
#endif
  return vec4<f32>(color, alpha);
}

// Keep the skinned Standard shader on the same multi-entry pass contract as
// the rigid Standard shader. Deferred draws select this entry point from the
// existing `forgeax::pbr-skin` artifact; lighting is performed by the deferred
// pass after these base surface facts are written to the shared G-buffer.
struct GBufferOutput {
  @location(0) normal_roughness : vec4<f32>,
  @location(1) albedo_metallic  : vec4<f32>,
  @location(2) emissive_ao      : vec4<f32>,
};

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
  let currentSkin = palette[in.skinIndex.x] * in.skinWeight.x +
    palette[in.skinIndex.y] * in.skinWeight.y +
    palette[in.skinIndex.z] * in.skinWeight.z +
    palette[in.skinIndex.w] * in.skinWeight.w;
  let previousSkin = previousPalette[in.skinIndex.x] * in.skinWeight.x +
    previousPalette[in.skinIndex.y] * in.skinWeight.y +
    previousPalette[in.skinIndex.z] * in.skinWeight.z +
    previousPalette[in.skinIndex.w] * in.skinWeight.w;
  let currentWorld = currentSkin * vec4<f32>(in.pos, 1.0);
  let previousWorld = previousSkin * vec4<f32>(in.pos, 1.0);
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
  _ = idx;
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
#if STORAGE_BUFFER_AVAILABLE == true
  let reactive = meshes[0].temporal.x;
#else
  let reactive = 1.0;
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
