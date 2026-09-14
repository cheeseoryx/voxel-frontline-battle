#define_import_path forgeax_pbr::ibl_sampling

// @forgeax/engine-shader - ibl-sampling.wgsl
// (feat-20260520-skylight-ibl-cubemap M3 / t47).
//
// Runtime IBL sampling helpers consumed by pbr.wgsl. Each helper takes the
// texture + sampler as function arguments rather than declaring its own
// @group/@binding, so the host (pbr.wgsl's @group(1) material BGL,
// Skylight resources at @binding(7..13) per D-5 round-4) owns the
// binding layout and this module composes cleanly anywhere.
//
// Zero @group/@binding declarations -- this is the symmetric counterpart
// to ibl-shared.wgsl for runtime sampling code.
//
// Exports:
//   - sampleIblDiffuse(N, irradianceMap, irradianceSampler)
//   - sampleIblSpecular(N, V, roughness, F0, prefilterMap, prefilterSampler,
//                       brdfLut, brdfLutSampler)
//   - box_project(worldPosition, direction, boxCenter, boxExtents)
//   - sampleReflectionProbeSpecular(..., probeMap, probeSampler, ...)

#import forgeax_pbr::ibl_shared::{fresnelSchlickRoughness, inverseRotateEnvironment}

// Sample pre-convolved irradiance from the irradiance cubemap.
// Y is negated to compensate for WebGPU's top-left texture origin vs the
// OpenGL convention used during equirect-to-cube render passes.
fn sampleIblDiffuse(
  normal: vec3<f32>,
  rotation: vec4<f32>,
  irradianceMap: texture_cube<f32>,
  irradianceSampler: sampler,
) -> vec3<f32> {
  let rotated = inverseRotateEnvironment(normal, rotation);
  let dir = vec3<f32>(rotated.x, -rotated.y, rotated.z);
  let irradianceEOverPi = textureSample(irradianceMap, irradianceSampler, dir).rgb;
  return irradianceEOverPi;
}

// Split-sum specular IBL: prefiltered env * (F0 * scale + bias).
fn sampleIblSpecular(
  normal: vec3<f32>,
  view: vec3<f32>,
  roughness: f32,
  F0: vec3<f32>,
  rotation: vec4<f32>,
  prefilterMap: texture_cube<f32>,
  prefilterSampler: sampler,
  brdfLut: texture_2d<f32>,
  brdfLutSampler: sampler,
) -> vec3<f32> {
  let NdotV = max(dot(normal, view), 0.001);
  let R = reflect(-view, normal);
  let rotated = inverseRotateEnvironment(R, rotation);
  let Rflip = vec3<f32>(rotated.x, -rotated.y, rotated.z);
  let mip = roughness * 4.0;
  let prefilteredColor = textureSampleLevel(prefilterMap, prefilterSampler, Rflip, mip).rgb;
  let envBRDF = textureSample(brdfLut, brdfLutSampler, vec2<f32>(NdotV, roughness)).rg;
  let F = fresnelSchlickRoughness(NdotV, F0, roughness);
  return prefilteredColor * (F * envBRDF.r + envBRDF.g);
}

// Project a reflection ray from a point inside a probe box onto the box
// boundary. The helper is binding-free so the scene table and the material
// resource projection remain owned by the host record stage.
fn box_project(
  worldPosition: vec3<f32>,
  direction: vec3<f32>,
  boxCenter: vec3<f32>,
  boxExtents: vec3<f32>,
) -> vec3<f32> {
  let safeExtents = max(boxExtents, vec3<f32>(0.0001));
  let safeDirection = select(
    vec3<f32>(0.0001),
    direction,
    abs(direction) >= vec3<f32>(0.0001),
  );
  let localPosition = worldPosition - boxCenter;
  let edgeSign = select(vec3<f32>(-1.0), vec3<f32>(1.0), direction >= vec3<f32>(0.0));
  let edge = edgeSign * safeExtents;
  let distances = (edge - localPosition) / safeDirection;
  let travel = min(distances.x, min(distances.y, distances.z));
  return normalize(localPosition + direction * max(travel, 0.0));
}

// Split-sum probe sample. The probe texture is supplied by the caller so a
// missing scene candidate can keep using sampleIblSpecular with the Skylight
// resources already present in the Standard material layout.
fn sampleReflectionProbeSpecular(
  normal: vec3<f32>,
  view: vec3<f32>,
  roughness: f32,
  F0: vec3<f32>,
  worldPosition: vec3<f32>,
  boxCenter: vec3<f32>,
  boxExtents: vec3<f32>,
  rotation: vec4<f32>,
  probeMap: texture_cube<f32>,
  probeSampler: sampler,
  brdfLut: texture_2d<f32>,
  brdfLutSampler: sampler,
) -> vec3<f32> {
  let NdotV = max(dot(normal, view), 0.001);
  let reflection = reflect(-view, normal);
  let projected = box_project(worldPosition, reflection, boxCenter, boxExtents);
  let rotated = inverseRotateEnvironment(projected, rotation);
  let probeDirection = vec3<f32>(rotated.x, -rotated.y, rotated.z);
  let mip = roughness * 4.0;
  let prefilteredColor = textureSampleLevel(probeMap, probeSampler, probeDirection, mip).rgb;
  let envBRDF = textureSample(brdfLut, brdfLutSampler, vec2<f32>(NdotV, roughness)).rg;
  let F = fresnelSchlickRoughness(NdotV, F0, roughness);
  return prefilteredColor * (F * envBRDF.r + envBRDF.g);
}
