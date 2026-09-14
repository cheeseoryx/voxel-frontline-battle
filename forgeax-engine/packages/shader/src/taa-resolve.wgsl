#define_import_path forgeax_view::taa_resolve

// Keep the fragment input shape explicit for compilers that tree-shake imported
// type declarations before resolving the vertex entry point.
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

fn fullscreen_triangle(vertex_index : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (vertex_index == 1u) {
    x = 3.0;
  }
  if (vertex_index == 2u) {
    y = 3.0;
  }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

struct TaaResolveParams {
  currentJitterUv : vec2<f32>,
  historyValid : u32,
  temporalFrameIndex : u32,
};

struct TaaResolveOutput {
  @location(0) color : vec4<f32>,
  @location(1) temporal : vec4<f32>,
};

@group(1) @binding(0) var currentColor : texture_2d<f32>;
@group(1) @binding(1) var currentSampler : sampler;
@group(1) @binding(2) var historyColor : texture_2d<f32>;
@group(1) @binding(3) var historySampler : sampler;
@group(1) @binding(4) var historyTemporal : texture_2d<f32>;
@group(1) @binding(5) var temporalSampler : sampler;
@group(1) @binding(6) var currentTemporal : texture_2d<f32>;
@group(1) @binding(7) var currentTemporalSampler : sampler;
@group(1) @binding(8) var<uniform> params : TaaResolveParams;

fn rgbToYCoCg(rgb : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(rgb, vec3<f32>(0.25, 0.5, 0.25)),
    dot(rgb, vec3<f32>(0.5, 0.0, -0.5)),
    dot(rgb, vec3<f32>(-0.25, 0.5, -0.25)),
  );
}

fn yCoCgToRgb(value : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(value.x + value.y - value.z, value.x + value.z, value.x - value.y - value.z);
}

fn luminance(rgb : vec3<f32>) -> f32 {
  return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn closestCurrentTemporal(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec4<f32> {
  let clamped = clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1));
  return textureLoad(currentTemporal, clamped, 0);
}

fn neighborhoodSquareMean(uv : vec2<f32>, texel : vec2<f32>) -> vec3<f32> {
  let north = textureSampleLevel(currentColor, currentSampler, uv + vec2<f32>(0.0, texel.y), 0.0).rgb;
  let south = textureSampleLevel(currentColor, currentSampler, uv - vec2<f32>(0.0, texel.y), 0.0).rgb;
  let east = textureSampleLevel(currentColor, currentSampler, uv + vec2<f32>(texel.x, 0.0), 0.0).rgb;
  let west = textureSampleLevel(currentColor, currentSampler, uv - vec2<f32>(texel.x, 0.0), 0.0).rgb;
  return (north + south + east + west) * 0.25;
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertexIndex);
}

fn fs_taa_resolve(in : FullscreenOutput) -> TaaResolveOutput {
  let dimensions = vec2<i32>(textureDimensions(currentColor, 0));
  let texel = 1.0 / vec2<f32>(dimensions);
  let current = textureSampleLevel(currentColor, currentSampler, in.uv + params.currentJitterUv, 0.0);
  let pixel = vec2<i32>(in.uv * vec2<f32>(dimensions));
  let temporal = closestCurrentTemporal(pixel, dimensions);
  let historyUv = in.uv - temporal.xy;
  let historyInBounds = all(historyUv >= vec2<f32>(0.0)) && all(historyUv <= vec2<f32>(1.0));
  let history = textureSampleLevel(historyColor, historySampler, historyUv, 0.0);
  let previousTemporal = textureSampleLevel(historyTemporal, temporalSampler, historyUv, 0.0);
  let depthDelta = abs(previousTemporal.z - temporal.z);
  let depthThreshold = 0.0025 + temporal.z * 0.01;
  let rejected =
    params.historyValid == 0u ||
    !historyInBounds ||
    temporal.z < 0.0 ||
    previousTemporal.z < 0.0 ||
    depthDelta > depthThreshold;
  let neighborhood = neighborhoodSquareMean(in.uv, texel);
  let neighborhoodDelta = abs(luminance(current.rgb) - luminance(neighborhood));
  let clipPadding = vec3<f32>(0.5);
  let clipMin = rgbToYCoCg(min(current.rgb, neighborhood - vec3<f32>(neighborhoodDelta) - clipPadding));
  let clipMax = rgbToYCoCg(max(current.rgb, neighborhood + vec3<f32>(neighborhoodDelta) + clipPadding));
  let clippedHistoryRgb = yCoCgToRgb(clamp(rgbToYCoCg(history.rgb), clipMin, clipMax));
  let reactiveFactor = 1.0 - clamp(temporal.w, 0.0, 1.0);
  let velocityFactor = 1.0 - clamp(length(temporal.xy) * 64.0, 0.0, 1.0);
  let depthFactor = 1.0 - clamp(depthDelta / depthThreshold, 0.0, 1.0);
  let unbiasedLumaDelta = clamp(abs(luminance(current.rgb) - luminance(history.rgb)), 0.0, 1.0);
  let lumaFactor = (1.0 - unbiasedLumaDelta) * (1.0 - unbiasedLumaDelta);
  let fixedPresetWeight = mix(0.88, 0.97, lumaFactor);
  let progressiveWeight = select(fixedPresetWeight, 0.0, params.temporalFrameIndex < 8u);
  let historyWeight = progressiveWeight * reactiveFactor * velocityFactor * depthFactor;
  let resolved = select(mix(current.rgb, clippedHistoryRgb, historyWeight), current.rgb, rejected);
  return TaaResolveOutput(
    vec4<f32>(resolved, current.a),
    temporal,
  );
}

@fragment
fn fs_main(in : FullscreenOutput) -> TaaResolveOutput {
  return fs_taa_resolve(in);
}
