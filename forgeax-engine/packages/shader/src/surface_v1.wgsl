#define_import_path forgeax_material::surface_v1

// Engine-owned input ABI for authored Standard material surfaces.
struct SurfaceInput {
  positionOS : vec3<f32>,
  positionWS : vec3<f32>,
  geometricNormalWS : vec3<f32>,
  tangentWS : vec4<f32>,
  viewDirectionWS : vec3<f32>,
  uv0 : vec2<f32>,
  uv1 : vec2<f32>,
  vertexColor : vec4<f32>,
  frontFacing : bool,
};

// Surface output is consumed by the Standard BRDF and pass family.
struct SurfaceData {
  baseColor : vec3<f32>,
  normalWS : vec3<f32>,
  metallic : f32,
  roughness : f32,
  emissive : vec3<f32>,
  occlusion : f32,
  opacity : f32,
  alphaClipThreshold : f32,
};
