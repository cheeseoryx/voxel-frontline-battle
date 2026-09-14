#define_import_path forgeax_material::default_standard_surface

#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}

// The default Surface owns only base facts. Standard's generated Material
// interface remains the source of the scalar and texture values; the
// Standard template owns physical-layer selection and lighting.
fn surfaceUv(input : SurfaceInput, transform : vec4<f32>, metadata : vec4<f32>) -> vec2<f32> {
  let source = select(input.uv0, input.uv1, metadata.x >= 1.0);
  let scaled = source * transform.zw;
  let c = cos(metadata.y);
  let s = sin(metadata.y);
  return vec2<f32>(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c) + transform.xy;
}

fn surfaceChannel(value : vec4<f32>, channel : u32) -> f32 {
  switch (channel) {
    case 0u: { return value.r; }
    case 1u: { return value.g; }
    case 2u: { return value.b; }
    default: { return value.a; }
  }
}

fn surfaceNormal(input : SurfaceInput, encoded : vec4<f32>, normalScale : f32) -> vec3<f32> {
  let tangentXY = (encoded.rg * 2.0 - vec2<f32>(1.0)) * normalScale;
  let tangentZ = sqrt(max(1.0 - dot(tangentXY, tangentXY), 0.0));
  let geometric = normalize(input.geometricNormalWS);
  let tangent = normalize(input.tangentWS.xyz - geometric * dot(geometric, input.tangentWS.xyz));
  let bitangent = normalize(cross(geometric, tangent)) * input.tangentWS.w;
  return normalize(tangent * tangentXY.x + bitangent * tangentXY.y + geometric * tangentZ);
}

fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  let baseSample = textureSample(
    baseColorTexture,
    baseColorTexture_sampler,
    surfaceUv(input, material.baseColorTextureCoordinatesTransform, material.baseColorTextureCoordinatesMetadata) * material.baseColorTextureCoordinatesMetadata.zw,
  );
  let metallicRoughnessSample = textureSample(
    metallicRoughnessTexture,
    metallicRoughnessTexture_sampler,
    surfaceUv(input, material.metallicRoughnessTextureCoordinatesTransform, material.metallicRoughnessTextureCoordinatesMetadata) * material.metallicRoughnessTextureCoordinatesMetadata.zw,
  );
  let normalSample = textureSample(
    normalTexture,
    normalTexture_sampler,
    surfaceUv(input, material.normalTextureCoordinatesTransform, material.normalTextureCoordinatesMetadata) * material.normalTextureCoordinatesMetadata.zw,
  );
  let emissiveSample = textureSample(
    emissiveTexture,
    emissiveTexture_sampler,
    surfaceUv(input, material.emissiveTextureCoordinatesTransform, material.emissiveTextureCoordinatesMetadata) * material.emissiveTextureCoordinatesMetadata.zw,
  );
  let occlusionSample = textureSample(
    occlusionTexture,
    occlusionTexture_sampler,
    surfaceUv(input, material.occlusionTextureCoordinatesTransform, material.occlusionTextureCoordinatesMetadata) * material.occlusionTextureCoordinatesMetadata.zw,
  );
  let vertexColor = input.vertexColor;
  let baseColor = material.baseColor.rgb * baseSample.rgb * vertexColor.rgb;
  let metallic = clamp(
    material.metallic * surfaceChannel(metallicRoughnessSample, u32(material.metallicChannel)),
    0.0,
    1.0,
  );
  let roughness = clamp(
    material.roughness * surfaceChannel(metallicRoughnessSample, u32(material.roughnessChannel)),
    0.04,
    1.0,
  );
  let emissive = material.emissive * material.emissiveIntensity * emissiveSample.rgb;
  let occlusion = clamp(
    1.0 + (occlusionSample.r - 1.0) * material.occlusionStrength,
    0.0,
    1.0,
  );
  return SurfaceData(
    baseColor,
    surfaceNormal(input, normalSample, material.normalScale),
    metallic,
    roughness,
    emissive,
    occlusion,
    clamp(material.baseColor.a * baseSample.a * vertexColor.a, 0.0, 1.0),
    clamp(material.alphaCutoff, 0.0, 1.0),
  );
}
