#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const caseInputPath = resolve(fileURLToPath(new URL('./case-input.json', import.meta.url)));
const caseInput = JSON.parse(readFileSync(caseInputPath, 'utf8'));
const source = 'analytic-raster-reference';
const revision = 'physical-material-reference-r3';
const configHash = createHash('sha256').update(JSON.stringify(caseInput)).digest('hex');
const camera = caseInput.camera.identity;
const metric = 'linear-hdr-rgb-mean';
const epsilon = 0.05;
const roi = { width: caseInput.projection.roiWidth, height: caseInput.projection.roiHeight };
const materialFixture = caseInput.material;

function schlick(cosine, f0) {
  return f0 + (1 - f0) * (1 - cosine) ** 5;
}

function ggx(normalHalf, roughness) {
  const alpha = roughness * roughness;
  const alphaSquared = alpha * alpha;
  const denominator = normalHalf * normalHalf * (alphaSquared - 1) + 1;
  return alphaSquared / (Math.PI * denominator * denominator);
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function coverageFraction(geometry, index) {
  const pixels = caseInput.geometry.coveragePixels[geometry][index];
  return pixels / (roi.width * roi.height);
}

function sceneRadiance(lighting) {
  return lighting === 'ibl'
    ? caseInput.ibl.referenceRadiance
    : caseInput.directLight.color;
}

function visibleSurfaceWeights(caseId, geometry, lighting) {
  if (geometry !== 'rigid' || lighting !== 'direct') return [{ normal: [0, 0, 1], weight: 1 }];
  const [x, y] = caseInput.geometry.casePositions[caseId];
  const toCamera = normalize([
    caseInput.camera.position[0] - x,
    caseInput.camera.position[1] - y,
    caseInput.camera.position[2],
  ]);
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    .map((normal) => ({ normal, weight: Math.max(0, dot(normal, toCamera)) }))
    .filter(({ weight }) => weight > 0);
  const total = faces.reduce((sum, face) => sum + face.weight, 0);
  return faces.map((face) => ({ ...face, weight: face.weight / total }));
}

function evaluateReference(caseId, lighting, geometry, semantic) {
  const textureSample = semantic === 'factor-r' ? [1, 0, 0] : semantic === 'roughness-g' ? [0, 1, 0] : [0.5, 0.5, 1];
  const factor = materialFixture.clearcoat * (semantic === 'factor-r' ? textureSample[0] : 1);
  const roughness = semantic === 'roughness-g'
    ? Math.max(0.045, materialFixture.clearcoatRoughness * textureSample[1])
    : materialFixture.clearcoatRoughness;
  // This is an independent fixed raster model. It consumes scene facts from
  // case-input.json and never reads candidate observations.
  const [x, y] = geometry === 'rigid' && lighting === 'direct'
    ? caseInput.geometry.casePositions[caseId]
    : [0, 0];
  const view = normalize([
    caseInput.camera.position[0] - x,
    caseInput.camera.position[1] - y,
    caseInput.camera.position[2],
  ]);
  const light = lighting === 'ibl'
    ? [0, 0, 1]
    : normalize(caseInput.directLight.direction.map((value) => -value));
  const radiance = sceneRadiance(lighting);
  // The RG fixture is the neutral tangent-space normal [0.5, 0.5, 1.0].
  // Scaling its XY components therefore leaves the decoded normal unchanged;
  // it must not be used as an arbitrary whole-layer energy multiplier.
  const normalScale = materialFixture.clearcoatNormalScale;
  const attenuationScale = 1;
  const surfaceWeights = visibleSurfaceWeights(caseId, geometry, lighting);
  const objectRadiance = [0, 0, 0];
  for (const { normal, weight } of surfaceWeights) {
    const viewDot = Math.max(0, dot(normal, view));
    const lightDot = Math.max(0, dot(normal, light));
    const half = normalize(view.map((value, index) => value + light[index]));
    const normalHalf = Math.max(0, dot(normal, half));
    const fresnel = schlick(viewDot, 0.04);
    const distribution = ggx(normalHalf, roughness);
    const visibility = 0.86 * lightDot;
    const attenuation = 1 - factor * fresnel * attenuationScale;
    const baseLobe = lighting === 'ibl'
      ? materialFixture.baseColor.slice(0, 3).map((base) => base * radiance[0] / Math.PI)
      : materialFixture.baseColor.slice(0, 3).map((base) => base * attenuation / Math.PI);
    const coatLobe = lighting === 'ibl'
      ? radiance.map((value) => factor * fresnel * (0.2 / (roughness * roughness + 0.01)) * normalScale * value)
      : radiance.map((value) => factor * fresnel * distribution * visibility * normalScale * value);
    for (let index = 0; index < objectRadiance.length; index += 1) {
      objectRadiance[index] += weight * (baseLobe[index] * radiance[index] + coatLobe[index]);
    }
  }
  const coverage = coverageFraction(geometry, semantic === 'factor-r' ? 0 : semantic === 'roughness-g' ? 1 : semantic === 'normal-rg' ? 2 : 3);
  const clearColor = caseInput.render.clearColor.slice(0, 3);
  return objectRadiance.map((value, index) => Number((clearColor[index] * (1 - coverage) + value * coverage).toFixed(6)));
}

function caseRoi(index) {
  return {
    x: (index % 4) * roi.width,
    y: Math.floor(index / 4) * roi.height,
    width: roi.width,
    height: roi.height,
  };
}

function hashReference(expectedLinearHdrMean, index) {
  const bytes = JSON.stringify({
    expectedLinearHdrMean,
    source,
    revision,
    configHash,
    camera,
    roi: caseRoi(index),
    metric,
    epsilon,
  });
  return createHash('sha256').update(bytes).digest('hex');
}

function createArtifact() {
  const cases = [];
  for (const lighting of ['direct', 'ibl']) {
    let phaseIndex = 0;
    for (const geometry of ['rigid', 'skinned']) {
      for (const semantic of ['factor-r', 'roughness-g', 'normal-rg', 'coat-normal-isolation']) {
        const caseId = `${lighting}-${geometry}-${semantic}`;
        const expectedLinearHdrMean = evaluateReference(caseId, lighting, geometry, semantic);
        cases.push({ caseId, roi: caseRoi(phaseIndex), expectedLinearHdrMean, referenceHash: hashReference(expectedLinearHdrMean, phaseIndex) });
        phaseIndex += 1;
      }
    }
  }
  return {
    artifactId: 'physical-material-reference-v3',
    generator: 'reference-generator.mjs',
    source,
    revision,
    configHash,
    camera,
    metric,
    epsilon,
    roi,
    scene: {
      input: 'case-input.json',
      render: caseInput.render,
      camera: caseInput.camera,
      directLight: caseInput.directLight,
      ibl: caseInput.ibl,
      geometry: caseInput.geometry,
      projection: caseInput.projection,
    },
    cases,
    paired: {
      'factor-zero-base-parity': { epsilon: 0.05 },
      'default-custom-surface-physical-parity': { epsilon: 0.05 },
      'additive-coat-falsifier': { metric: 'linear-rgb-l1', baselineNoise: 0.001, energyTolerance: 0.05 },
    },
  };
}

const artifactPath = resolve(fileURLToPath(new URL('./reference-linear-hdr.json', import.meta.url)));
const expected = createArtifact();
if (process.argv.includes('--check')) {
  const actual = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error('reference artifact differs from deterministic generator');
    process.exit(1);
  }
  console.log(`reference artifact verified: ${expected.cases.length} rows`);
} else {
  console.log(JSON.stringify(expected, null, 2));
}
