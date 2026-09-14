#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis SKINNING_DISABLED
#pragma material_slot surface
#define_import_path forgeax::default-shadow-caster
#import forgeax_material::slot::surface::{evaluate_surface}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{material}

// @forgeax/engine-shader shadow_caster.wgsl
// feat-20260520-directional-light-shadow-mapping M1c / w9 (D-9 / AC-09):
// depth pass for directional shadow map. The fragment stage evaluates the
// selected Standard Surface so opacity/alpha-clip stays identical to Forward
// and Deferred (depth32float is still the only render target).
//
// feat-20260613-csm-cascaded-shadow-maps M5 / w28: per-cascade
// lightViewProj selection. Each cascade pass writes a different
// `shadowCasterCascade.index` (0..3) before encoder submit; the vertex
// shader reads it to pick `view.lightViewProj_A..D`. The atlas tile UV
// inset is already baked into each lightViewProj host-side
// (render-system-extract.ts), so the per-cascade viewport on the depth
// pass clips rasterization to the correct atlas tile while the matrix
// itself maps NDC straight into atlas-space [0,1]^2.
//
// Reuses:
//   @group(0) binding(0) view : View                 -- common.wgsl
//   @group(0) binding(5) shadowCasterCascade         -- common.wgsl
//   @group(2) binding(0) meshes : array<Mesh>        -- common.wgsl
//   @group(3) binding(0) instances : array<InstanceData>  -- common.wgsl
//
// SKINNING_DISABLED=true consumes the ordinary 12F mesh layout; the explicit
// false variant consumes JOINTS_0 / WEIGHTS_0 from the same 18F layout as pbr-skin and
// projects the animated world-space palette result into the shadow view.

#import forgeax_view::common::{View, Mesh, InstanceData, ShadowCasterCascade, view, shadowCasterCascade, meshes, instances}

struct VsInput {
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) tangent : vec4<f32>,
#if SKINNING_DISABLED == false
  @location(4) skinIndex : vec4<u32>,
  @location(5) skinWeight : vec4<f32>,
#endif
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) positionOS : vec3<f32>,
  @location(1) positionWS : vec3<f32>,
  @location(2) normalWS : vec3<f32>,
  @location(3) tangentWS : vec4<f32>,
  @location(4) surfaceUv : vec2<f32>,
  @location(5) vertexColor : vec4<f32>,
};

#if SKINNING_DISABLED == false
#if STORAGE_BUFFER_AVAILABLE == true
@group(2) @binding(1) var<storage, read> palette : array<mat4x4<f32>>;
#else
@group(2) @binding(1) var<uniform> palette : array<mat4x4<f32>, 255>;
#endif
#endif

fn _cascadeLightViewProj(layer : u32) -> mat4x4<f32> {
  switch (layer) {
    case 0u: { return view.lightViewProj_A; }
    case 1u: { return view.lightViewProj_B; }
    case 2u: { return view.lightViewProj_C; }
    default: { return view.lightViewProj_D; }
  }
}

@vertex
fn vs_main(in : VsInput, @builtin(instance_index) idx : u32) -> VsOut {
#if SKINNING_DISABLED == false
  let skinMatrix = palette[in.skinIndex.x] * in.skinWeight.x +
    palette[in.skinIndex.y] * in.skinWeight.y +
    palette[in.skinIndex.z] * in.skinWeight.z +
    palette[in.skinIndex.w] * in.skinWeight.w;
  // Palette entries are jointWorld * inverseBind and therefore already
  // produce world-space positions. Applying meshes[0].worldFromLocal again
  // would double-transform a parented skinned entity.
  let worldPos = skinMatrix * vec4<f32>(in.position, 1.0);
  let worldNormal = normalize((skinMatrix * vec4<f32>(in.normal, 0.0)).xyz);
  let worldTangent = normalize((skinMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
#else
  let instanceLocal = instances[idx].localFromInstance;
  let worldMatrix = meshes[0].worldFromLocal * instanceLocal;
  let worldPos = worldMatrix * vec4<f32>(in.position, 1.0);
  let worldNormal = normalize((worldMatrix * vec4<f32>(in.normal, 0.0)).xyz);
  let worldTangent = normalize((worldMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
#endif
  // feat-20260625-spot-light-shadow-mapping M2 / w10 (D-1): spot shadow passes
  // set `isSpot = 1u` and write their perspective matrix into
  // `spotLightViewProj`; directional cascade passes keep `isSpot = 0u` and read
  // `view.lightViewProj_A..D` via `index`. Routing on the discriminant keeps
  // the spot matrix out of the directional View UBO (no same-frame contention).
  if (shadowCasterCascade.isSpot == 1u) {
    var out : VsOut;
    out.clip = shadowCasterCascade.spotLightViewProj * worldPos;
    out.positionOS = in.position;
    out.positionWS = worldPos.xyz;
    out.normalWS = worldNormal;
    out.tangentWS = vec4<f32>(worldTangent, in.tangent.w);
    out.surfaceUv = in.uv;
    out.vertexColor = vec4<f32>(1.0);
    return out;
  }
  let lvp = _cascadeLightViewProj(shadowCasterCascade.index);
  var out : VsOut;
  out.clip = lvp * worldPos;
  out.positionOS = in.position;
  out.positionWS = worldPos.xyz;
  out.normalWS = worldNormal;
  out.tangentWS = vec4<f32>(worldTangent, in.tangent.w);
  out.surfaceUv = in.uv;
  out.vertexColor = vec4<f32>(1.0);
  return out;
}

fn evaluateShadowSurface(in : VsOut, frontFacing : bool) -> SurfaceData {
  let viewDirectionWS = normalize(view.cameraPos - in.positionWS);
  return evaluate_surface(SurfaceInput(
    in.positionOS,
    in.positionWS,
    in.normalWS,
    in.tangentWS,
    viewDirectionWS,
    in.surfaceUv,
    in.surfaceUv,
    in.vertexColor,
    frontFacing,
  ));
}

fn alphaTestShadowSurface(surface : SurfaceData) {
  if (surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold) {
    discard;
  }
}

// The depth-only path evaluates the selected Surface so alpha-clip ownership
// remains shared with Forward and Deferred without mutating vertex data.
@fragment
fn fs_shadow(in : VsOut, @builtin(front_facing) frontFacing : bool) {
  alphaTestShadowSurface(evaluateShadowSurface(in, frontFacing));
}

@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) {
  alphaTestShadowSurface(evaluateShadowSurface(in, frontFacing));
}
