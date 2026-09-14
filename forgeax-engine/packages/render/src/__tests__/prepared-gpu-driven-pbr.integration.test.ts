import { vec3 } from '@forgeax/engine-math';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { buildGpuDrivenDraws, resolvePreparedGpuDrivenDraw } from '../extract/gpu-driven';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';

const textureNames = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'specularColorTexture',
  'emissiveTexture',
  'occlusionTexture',
  'transmissionTexture',
  'thicknessTexture',
] as const;

function material(): MaterialSnapshot {
  return {
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    materialShaderId: 'forgeax::default-standard-pbr',
    textureHandles: new Map(textureNames.map((name, index) => [name, index + 1])) as never,
    samplerHandles: new Map(textureNames.map((name, index) => [name, index + 101])) as never,
  };
}

function snapshot(
  draws?: readonly NonNullable<RenderableSnapshot['gpuDrivenDraws']>[number][],
): RenderableSnapshot {
  const draw = {
    kind: 'indexed' as const,
    first: 0,
    count: 36,
    baseVertex: 0,
    materialSlot: 0,
    topology: 'triangle-list' as const,
    pipelineClass: 'standard-pbr',
    materialResourceClass: 'standard-pbr-resources',
  };
  return {
    assetHandle: 1,
    transform: { world: new Float32Array(16) },
    material: material(),
    materials: [material()],
    materialBindingSources: [],
    worldId: 0,
    entityKey: 1,
    gpuDrivenDraws: draws ?? [draw],
  };
}

function geometry(source: ReturnType<typeof artifact>) {
  return {
    identity: 'canonical-pbr-geometry',
    vertexInputs: source.receipt.vertexInputs,
    topology: 'triangle-list' as const,
    indexed: true,
  };
}

function artifact() {
  const receipt = createStandardPbrArtifactReceipt();
  return {
    material: 'forgeax::default-standard-pbr',
    pass: 'forward',
    wgsl: 'producer-composed-standard-pbr',
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: ['forgeax_material::standard'],
    vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
    receipt,
  };
}

describe('prepared Standard PBR producer-to-record integration', () => {
  it('carries one producer receipt to direct and scene-index preparation', () => {
    const source = artifact();
    const result = resolvePreparedGpuDrivenDraw({
      snapshot: snapshot(),
      artifact: source,
      geometry: geometry(source),
      generation: source.receipt.generation,
      draw: snapshot().gpuDrivenDraws?.[0] as NonNullable<
        RenderableSnapshot['gpuDrivenDraws']
      >[number],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.directEntry).toBe('vs_main');
    expect(result.value.sceneIndexEntry).toBe('vs_scene_index');
    expect(result.value.resourceSlots).toBe(source.receipt.resourceSlots);
    expect(result.value.identity.deformation).toBe('rigid');
  });

  it.each([
    ['stale generation', (source: ReturnType<typeof artifact>) => source.receipt.generation + 1],
    ['missing resources', (source: ReturnType<typeof artifact>) => source.receipt.generation],
  ])('fails before recording for %s', (_label, generation) => {
    const source = artifact();
    const baseSnapshot = snapshot();
    const drawSnapshot =
      _label === 'missing resources'
        ? {
            ...baseSnapshot,
            material: { ...baseSnapshot.material, textureHandles: undefined },
            materials: [{ ...baseSnapshot.material, textureHandles: undefined }],
          }
        : baseSnapshot;
    const result = resolvePreparedGpuDrivenDraw({
      snapshot: drawSnapshot,
      artifact: source,
      geometry: geometry(source),
      generation: generation(source),
      draw: baseSnapshot.gpuDrivenDraws?.[0] as NonNullable<
        RenderableSnapshot['gpuDrivenDraws']
      >[number],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      _label === 'stale generation' ? 'stale-generation' : 'resource-not-ready',
    );
    expect(result.error.detail.reason).toBe(
      _label === 'stale generation' ? 'generation-stale' : 'material-resource-missing',
    );
  });

  it('prepares every extracted submesh draw from its own range and material receipt', () => {
    const source = artifact();
    const draws = buildGpuDrivenDraws({
      submeshes: [
        {
          vertexCount: 36,
          indexCount: 36,
          indexOffset: 0,
          materialSlot: 0,
          topology: 'triangle-list',
        },
        {
          vertexCount: 12,
          indexCount: 12,
          indexOffset: 36,
          materialSlot: 0,
          topology: 'triangle-list',
        },
      ],
      indexed: true,
      materials: [material()],
      fallbackMaterial: material(),
      prepare(draw, _drawMaterial) {
        const result = resolvePreparedGpuDrivenDraw({
          snapshot: snapshot(),
          artifact: source,
          geometry: geometry(source),
          generation: source.receipt.generation,
          draw,
        });
        return result.ok ? result.value : undefined;
      },
    });

    expect(draws).toHaveLength(2);
    expect(draws.map((draw) => draw.prepared?.first)).toEqual([0, 36]);
    expect(draws.map((draw) => draw.prepared?.count)).toEqual([36, 12]);
    expect(draws.every((draw) => draw.prepared?.topology === draw.topology)).toBe(true);
    expect(
      draws.every((draw) => draw.prepared?.identity.geometry === 'canonical-pbr-geometry'),
    ).toBe(true);
  });

  it('returns a structured receipt error without adding a duplicate CPU draw', () => {
    const source = artifact();
    const base = snapshot();
    const draw = base.gpuDrivenDraws?.[0] as NonNullable<
      RenderableSnapshot['gpuDrivenDraws']
    >[number];
    const result = resolvePreparedGpuDrivenDraw({
      snapshot: base,
      artifact: (() => {
        const { receipt: _receipt, ...withoutReceipt } = source;
        return withoutReceipt;
      })(),
      geometry: geometry(source),
      generation: source.receipt.generation,
      draw,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing-material-receipt');
    expect(base.gpuDrivenDraws).toHaveLength(1);
  });
});
