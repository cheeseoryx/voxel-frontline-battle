#define_import_path forgeax_pbr::lighting_rect_area
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{ltcLambertTexture, ltcGgxTexture, spotModifierSampler}
#endif

// One-sided finite-area direct lighting using the same Heitz LTC formulation
// and tracked 64x64 tables as Three.js r184. The rectangle corners, rather
// than a punctual center direction, are transformed into the fitted cosine
// space before the spherical edge integral is evaluated.

fn ltcUv(n : vec3<f32>, v : vec3<f32>, roughness : f32) -> vec2<f32> {
  let lutScale = 63.0 / 64.0;
  let lutBias = 0.5 / 64.0;
  let nDotV = clamp(dot(n, v), 0.0, 1.0);
  return vec2<f32>(clamp(roughness, 0.0, 1.0), sqrt(1.0 - nDotV)) * lutScale + lutBias;
}

fn ltcClippedSphereFormFactor(f : vec3<f32>) -> f32 {
  let magnitude = length(f);
  return max((magnitude * magnitude + f.z) / (magnitude + 1.0), 0.0);
}

fn ltcEdgeVectorFormFactor(v1 : vec3<f32>, v2 : vec3<f32>) -> vec3<f32> {
  let x = clamp(dot(v1, v2), -1.0, 1.0);
  let y = abs(x);
  let a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  let b = 3.4175940 + (4.1616724 + y) * y;
  let rational = a / b;
  let thetaOverSinTheta = select(
    0.5 * inverseSqrt(max(1.0 - x * x, 1e-7)) - rational,
    rational,
    x > 0.0,
  );
  return cross(v1, v2) * thetaOverSinTheta;
}

fn ltcEvaluate(
  n : vec3<f32>,
  v : vec3<f32>,
  worldPos : vec3<f32>,
  mInv : mat3x3<f32>,
  lightPos : vec3<f32>,
  axisX : vec3<f32>,
  axisY : vec3<f32>,
  halfWidth : f32,
  halfHeight : f32,
) -> f32 {
  let halfX = axisX * halfWidth;
  let halfY = axisY * halfHeight;
  // Counter-clockwise from the authored front (+cross(axisX, axisY)).
  let rect0 = lightPos - halfX - halfY;
  let rect1 = lightPos + halfX - halfY;
  let rect2 = lightPos + halfX + halfY;
  let rect3 = lightPos - halfX + halfY;
  let lightNormal = cross(rect1 - rect0, rect3 - rect0);
  if (dot(lightNormal, worldPos - rect0) <= 0.0) {
    return 0.0;
  }

  let tangentCandidate = v - n * dot(v, n);
  let tangentLengthSquared = dot(tangentCandidate, tangentCandidate);
  var tangent = vec3<f32>(1.0, 0.0, 0.0);
  if (tangentLengthSquared > 1e-7) {
    tangent = tangentCandidate * inverseSqrt(tangentLengthSquared);
  } else {
    let fallback = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.x) < 0.9);
    tangent = normalize(cross(fallback, n));
  }
  let bitangent = -cross(n, tangent);
  let transform = mInv * transpose(mat3x3<f32>(tangent, bitangent, n));

  let c0 = normalize(transform * (rect0 - worldPos));
  let c1 = normalize(transform * (rect1 - worldPos));
  let c2 = normalize(transform * (rect2 - worldPos));
  let c3 = normalize(transform * (rect3 - worldPos));
  let vectorFormFactor =
    ltcEdgeVectorFormFactor(c0, c1) +
    ltcEdgeVectorFormFactor(c1, c2) +
    ltcEdgeVectorFormFactor(c2, c3) +
    ltcEdgeVectorFormFactor(c3, c0);
  return ltcClippedSphereFormFactor(vectorFormFactor);
}

fn rectAreaRangeFactor(lightPos : vec3<f32>, worldPos : vec3<f32>, invRangeSquared : f32) -> f32 {
  let toLight = lightPos - worldPos;
  let distanceSquared = dot(toLight, toLight);
  let rangeTerm = distanceSquared * invRangeSquared;
  let factor = clamp(1.0 - rangeTerm * rangeTerm, 0.0, 1.0);
  return factor * factor;
}

fn evalRectAreaLtcDiffuse(
  lightPos : vec3<f32>, lightColor : vec3<f32>, axisX : vec3<f32>, axisY : vec3<f32>,
  halfWidth : f32, halfHeight : f32, invRangeSquared : f32, worldPos : vec3<f32>,
  n : vec3<f32>, v : vec3<f32>, baseColor : vec3<f32>, metallic : f32, alphaSq : f32, F0 : vec3<f32>,
) -> vec3<f32> {
  let identity = mat3x3<f32>(
    vec3<f32>(1.0, 0.0, 0.0),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0),
  );
  let formFactor = ltcEvaluate(
    n, v, worldPos, identity, lightPos, axisX, axisY, halfWidth, halfHeight,
  );
  // The LTC edge fit is already normalized by 1/(2*pi); unlike punctual
  // irradiance this form factor must not receive another Lambert 1/pi.
  let diffuse = baseColor * (1.0 - metallic);
  return lightColor * diffuse * formFactor * rectAreaRangeFactor(lightPos, worldPos, invRangeSquared);
}

fn evalRectAreaLtcStandard(
  lightPos : vec3<f32>, lightColor : vec3<f32>, axisX : vec3<f32>, axisY : vec3<f32>,
  halfWidth : f32, halfHeight : f32, invRangeSquared : f32, worldPos : vec3<f32>,
  n : vec3<f32>, v : vec3<f32>, baseColor : vec3<f32>, metallic : f32, alphaSq : f32, F0 : vec3<f32>,
) -> vec3<f32> {
#ifdef EXTENDED_LIGHTING_AVAILABLE
  let uv = ltcUv(n, v, sqrt(max(alphaSq, 0.0)));
  let matrixSample = textureSampleLevel(ltcLambertTexture, spotModifierSampler, uv, 0.0);
  let fresnelSample = textureSampleLevel(ltcGgxTexture, spotModifierSampler, uv, 0.0);
  let mInv = mat3x3<f32>(
    vec3<f32>(matrixSample.x, 0.0, matrixSample.y),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(matrixSample.z, 0.0, matrixSample.w),
  );
  let fresnel = F0 * fresnelSample.x + (vec3<f32>(1.0) - F0) * fresnelSample.y;
  let specularFormFactor = ltcEvaluate(
    n, v, worldPos, mInv, lightPos, axisX, axisY, halfWidth, halfHeight,
  );
  let diffuse = evalRectAreaLtcDiffuse(
    lightPos, lightColor, axisX, axisY, halfWidth, halfHeight, invRangeSquared,
    worldPos, n, v, baseColor, metallic, alphaSq, F0,
  );
  return diffuse + lightColor * fresnel * specularFormFactor * rectAreaRangeFactor(lightPos, worldPos, invRangeSquared);
#else
  return vec3<f32>(0.0);
#endif
}

// Both renderer routes consume one complete Standard-PBR Rect contribution.
// The public names retain the direct/cluster shader import contract while the
// Lambert and fitted-GGX terms stay inseparable in one owner implementation.
fn evalRectAreaLtcLambert(
  lightPos : vec3<f32>, lightColor : vec3<f32>, axisX : vec3<f32>, axisY : vec3<f32>,
  halfWidth : f32, halfHeight : f32, invRangeSquared : f32, worldPos : vec3<f32>,
  n : vec3<f32>, v : vec3<f32>, baseColor : vec3<f32>, metallic : f32, alphaSq : f32, F0 : vec3<f32>,
) -> vec3<f32> {
  return evalRectAreaLtcStandard(
    lightPos, lightColor, axisX, axisY, halfWidth, halfHeight, invRangeSquared,
    worldPos, n, v, baseColor, metallic, alphaSq, F0,
  );
}

fn evalRectAreaLtcGgx(
  lightPos : vec3<f32>, lightColor : vec3<f32>, axisX : vec3<f32>, axisY : vec3<f32>,
  halfWidth : f32, halfHeight : f32, invRangeSquared : f32, worldPos : vec3<f32>,
  n : vec3<f32>, v : vec3<f32>, baseColor : vec3<f32>, metallic : f32, alphaSq : f32, F0 : vec3<f32>,
) -> vec3<f32> {
  return evalRectAreaLtcStandard(
    lightPos, lightColor, axisX, axisY, halfWidth, halfHeight, invRangeSquared,
    worldPos, n, v, baseColor, metallic, alphaSq, F0,
  );
}
