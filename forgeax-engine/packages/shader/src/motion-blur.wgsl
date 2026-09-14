#define_import_path forgeax_view::motion_blur

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::fullscreen_triangle
#import forgeax_scene_temporal::{unpackSceneTemporalV1}

struct MotionBlurParams {
  shutterAngle : f32,
  maxRadiusPixels : f32,
  sampleCount : u32,
  reset : u32,
};

@group(1) @binding(0) var currentColor : texture_2d<f32>;
@group(1) @binding(1) var linearSampler : sampler;
@group(1) @binding(2) var<uniform> params : MotionBlurParams;
@group(1) @binding(3) var sceneTemporal : texture_2d<f32>;

fn depthReject(center : f32, sample : f32) -> bool {
  return abs(center - sample) > max(0.01, center * 0.01);
}

fn symmetricOffset(index : u32, count : u32, motion : vec2<f32>) -> vec2<f32> {
  let denominator = max(f32(count), 1.0);
  let signedIndex = f32(index) - (denominator - 1.0) * 0.5;
  return motion * (signedIndex / denominator);
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertexIndex);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let current = textureSampleLevel(currentColor, linearSampler, in.uv, 0.0);
  let packed = textureSampleLevel(sceneTemporal, linearSampler, in.uv, 0.0);
  let temporal = unpackSceneTemporalV1(packed);
  let dimensions = vec2<f32>(textureDimensions(currentColor));
  let pixelMotion = temporal.motionUv * dimensions;
  let shutter = clamp(params.shutterAngle / 360.0, 0.0, 1.0);
  let radius = min(length(pixelMotion) * shutter, params.maxRadiusPixels);
  let motion = normalize(select(vec2<f32>(0.0), pixelMotion, radius > 1e-5));
  let invalidDepth = !temporal.validDepth;
  let reactive = clamp(temporal.reactive, 0.0, 1.0);
  let subpixel = radius <= 1e-5;
  let reset = params.reset != 0u;
  var output = current;
  output.a = current.a;
  if (invalidDepth || subpixel || reset || params.sampleCount < 4u) {
    return output;
  }

  var accum = vec3<f32>(0.0);
  var weight = 0.0;
  let temporalDimensions = vec2<i32>(textureDimensions(sceneTemporal));
  for (var index = 0u; index < 16u; index += 1u) {
    if (index >= params.sampleCount) { break; }
    let offset = symmetricOffset(index, params.sampleCount, motion * radius) / dimensions;
    let sampleUv = clamp(in.uv + offset, vec2<f32>(0.0), vec2<f32>(1.0));
    let samplePixel = clamp(
      vec2<i32>(sampleUv * dimensions),
      vec2<i32>(0),
      temporalDimensions - vec2<i32>(1),
    );
    let sampleTemporal = unpackSceneTemporalV1(textureLoad(sceneTemporal, samplePixel, 0));
    if (sampleTemporal.validDepth && !depthReject(temporal.viewDepth, sampleTemporal.viewDepth)) {
      accum += textureSampleLevel(currentColor, linearSampler, sampleUv, 0.0).rgb;
      weight += 1.0;
    }
  }
  let gathered = accum / max(weight, 1.0);
  let blurWeight = (1.0 - reactive) * select(0.0, 1.0, weight > 0.0);
  output = vec4<f32>(mix(current.rgb, gathered, blurWeight), current.a);
  output.a = current.a;
  return output;
}
