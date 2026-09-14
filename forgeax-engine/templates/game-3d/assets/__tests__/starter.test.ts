import { readdir, readFile } from 'node:fs/promises';
import { deriveAnimationTargetId } from '@forgeax/engine/animation';
import { createUiImporter } from '@forgeax/engine/ui/importer';
import { describe, expect, it } from 'vitest';
import characterPack from '../character.pack.ts';
import environmentPack from '../environment.pack.ts';
import fantasyMeshesPack from '../fantasy-meshes.pack.ts';
import geometryPack from '../geometry.pack.ts';
import materialsPack from '../materials.pack.ts';
import scenePack from '../scene.pack.ts';
import { RUSTED_IRON_MATERIAL_GUID } from '../shared/asset-refs.ts';
import { PLAYER_RIG } from '../player/player-rig.ts';
import {
  MAX_CAMERA_PITCH,
  MIN_CAMERA_PITCH,
  cameraRelativeMove,
  facingYaw,
  horizontalCameraAxes,
  integratePointerLook,
} from '../camera/third-person.ts';

/**
 * These tests pin the canonical reference's engine and asset contracts. Keep
 * assertions that prove reusable behavior, but rewrite or remove sample-name
 * and sample-composition assertions when the template becomes a new product.
 */
async function build(pack: { readonly build: (reader: never) => unknown }): Promise<Record<string, unknown>> {
  const result = await pack.build(undefined as never);
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) {
    throw new Error(`ScriptablePack build failed: ${JSON.stringify(result)}`);
  }
  return (result as unknown as { readonly value: Record<string, unknown> }).value;
}

type Matrix = number[];

function multiplyMatrix(a: readonly number[], b: readonly number[]): Matrix {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let lane = 0; lane < 4; lane += 1) {
        out[column * 4 + row] += (a[lane * 4 + row] ?? 0) * (b[column * 4 + lane] ?? 0);
      }
    }
  }
  return out;
}

function localMatrix(translation: readonly number[], quaternion: readonly number[]): Matrix {
  const [x = 0, y = 0, z = 0, w = 1] = quaternion;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0,
    translation[0] ?? 0, translation[1] ?? 0, translation[2] ?? 0, 1,
  ];
}

function playerTargetPath(joint: number): readonly string[] {
  const names: string[] = [];
  let cursor = joint;
  while (cursor >= 0) {
    const entry = PLAYER_RIG[cursor];
    if (entry === undefined) break;
    names.unshift(entry.name);
    cursor = entry.parent;
  }
  return ['Player', ...names];
}

function maximumAnimatedEdgeStretch(
  mesh: {
    readonly indices: Uint32Array;
    readonly attributes: {
      readonly position?: Float32Array;
      readonly skinIndex?: Uint16Array;
      readonly skinWeight?: Float32Array;
    };
  },
  skeleton: { readonly inverseBindMatrices: Float32Array },
  clip: {
    readonly channels: readonly {
      readonly targetId: number;
      readonly property: string;
      readonly sampler: { readonly input: Float32Array; readonly output: Float32Array };
    }[];
  },
): { readonly ratio: number; readonly detail: string } {
  const positions = mesh.attributes.position ?? new Float32Array();
  const jointIndices = mesh.attributes.skinIndex ?? new Uint16Array();
  const jointWeights = mesh.attributes.skinWeight ?? new Float32Array();
  const channelByTargetAndProperty = new Map<string, (typeof clip.channels)[number]>(
    clip.channels.map((channel) => [`${String(channel.targetId)}:${channel.property}`, channel] as const),
  );
  let maximum = 1;
  let detail = '';
  for (const sampleTime of [0.25, 0.75]) {
    const worlds: Matrix[] = [];
    for (let joint = 0; joint < PLAYER_RIG.length; joint += 1) {
      const rigJoint = PLAYER_RIG[joint];
      if (rigJoint === undefined) continue;
      const targetId = deriveAnimationTargetId(playerTargetPath(joint));
      const translationChannel = channelByTargetAndProperty.get(`${String(targetId)}:translation`);
      const rotationChannel = channelByTargetAndProperty.get(`${String(targetId)}:rotation`);
      const translationKey = translationChannel?.sampler.input.findIndex((time) => time === sampleTime) ?? -1;
      const rotationKey = rotationChannel?.sampler.input.findIndex((time) => time === sampleTime) ?? -1;
      const translation = translationKey >= 0
        ? Array.from(translationChannel?.sampler.output.slice(translationKey * 3, translationKey * 3 + 3) ?? rigJoint.local)
        : rigJoint.local;
      const rotation = rotationKey >= 0
        ? Array.from(rotationChannel?.sampler.output.slice(rotationKey * 4, rotationKey * 4 + 4) ?? [0, 0, 0, 1])
        : [0, 0, 0, 1];
      const local = localMatrix(translation, rotation);
      worlds[joint] = rigJoint.parent < 0 ? local : multiplyMatrix(worlds[rigJoint.parent] ?? localMatrix([0, 0, 0], [0, 0, 0, 1]), local);
    }
    const palettes = worlds.map((world, joint) =>
      multiplyMatrix(world, Array.from(skeleton.inverseBindMatrices.slice(joint * 16, joint * 16 + 16))),
    );
    const deformed = new Float32Array(positions.length);
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const source = [positions[vertex * 3] ?? 0, positions[vertex * 3 + 1] ?? 0, positions[vertex * 3 + 2] ?? 0];
      for (let lane = 0; lane < 4; lane += 1) {
        const weight = jointWeights[vertex * 4 + lane] ?? 0;
        if (weight <= 0) continue;
        const matrix = palettes[jointIndices[vertex * 4 + lane] ?? 0];
        if (matrix === undefined) continue;
        deformed[vertex * 3] += weight * ((matrix[0] ?? 0) * source[0] + (matrix[4] ?? 0) * source[1] + (matrix[8] ?? 0) * source[2] + (matrix[12] ?? 0));
        deformed[vertex * 3 + 1] += weight * ((matrix[1] ?? 0) * source[0] + (matrix[5] ?? 0) * source[1] + (matrix[9] ?? 0) * source[2] + (matrix[13] ?? 0));
        deformed[vertex * 3 + 2] += weight * ((matrix[2] ?? 0) * source[0] + (matrix[6] ?? 0) * source[1] + (matrix[10] ?? 0) * source[2] + (matrix[14] ?? 0));
      }
    }
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = [mesh.indices[offset] ?? 0, mesh.indices[offset + 1] ?? 0, mesh.indices[offset + 2] ?? 0];
      for (let edge = 0; edge < 3; edge += 1) {
        const a = triangle[edge] ?? 0;
        const b = triangle[(edge + 1) % 3] ?? 0;
        const rest = Math.hypot(
          (positions[a * 3] ?? 0) - (positions[b * 3] ?? 0),
          (positions[a * 3 + 1] ?? 0) - (positions[b * 3 + 1] ?? 0),
          (positions[a * 3 + 2] ?? 0) - (positions[b * 3 + 2] ?? 0),
        );
        if (rest < 0.01) continue;
        const animated = Math.hypot(
          (deformed[a * 3] ?? 0) - (deformed[b * 3] ?? 0),
          (deformed[a * 3 + 1] ?? 0) - (deformed[b * 3 + 1] ?? 0),
          (deformed[a * 3 + 2] ?? 0) - (deformed[b * 3 + 2] ?? 0),
        );
        const ratio = animated / rest;
        if (ratio > maximum) {
          maximum = ratio;
          const describeVertex = (vertex: number) => ({
            position: Array.from(positions.slice(vertex * 3, vertex * 3 + 3)),
            joints: Array.from(jointIndices.slice(vertex * 4, vertex * 4 + 4)),
            weights: Array.from(jointWeights.slice(vertex * 4, vertex * 4 + 4)),
          });
          detail = JSON.stringify({ sampleTime, a: describeVertex(a), b: describeVertex(b), rest, animated });
        }
      }
    }
  }
  return { ratio: maximum, detail };
}

describe('game-3d starter', () => {
  it('uses one authored root group for the manifest plugin graph', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../forge.json', import.meta.url), 'utf8')) as {
      readonly plugins: readonly { readonly name: string }[];
    };
    expect(manifest.plugins.map((entry) => entry.name)).toEqual([
      '@forgeax/engine/physics/rapier3d',
      './assets/plugin.ts',
    ]);
    expect(await readFile(new URL('../plugin.ts', import.meta.url), 'utf8')).toContain(
      'definePluginGroup({',
    );
  });

  it('keeps one source per asset owner and a readable UI authoring pair', async () => {
    const entries = (await readdir(new URL('../', import.meta.url))).sort();
    expect(entries).toEqual([
      '__tests__',
      'camera',
      'character.pack.ts',
      'environment.pack.ts',
      'fantasy-meshes.pack.ts',
      'geometry.pack.ts',
      'guide.ui.css',
      'guide.ui.html',
      'guide.ui.html.meta.json',
      'materials.pack.ts',
      'player',
      'plugin.ts',
      'scene.pack.ts',
      'shaders',
      'shared',
      'ui',
      'world',
    ]);
    const html = await readFile(new URL('../guide.ui.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../guide.ui.css', import.meta.url), 'utf8');
    const meta = JSON.parse(
      await readFile(new URL('../guide.ui.html.meta.json', import.meta.url), 'utf8'),
    );
    expect(html).toContain('WASD move');
    expect(html).toContain('\n');
    expect(css).toContain(':host {');
    expect(css).toContain('\n');
    expect(meta).toMatchObject({ importer: 'ui', source: 'guide.ui.html' });
    expect(meta.subAssets).toEqual([
      expect.objectContaining({ sourceKey: 'ui/guide', kind: 'ui' }),
    ]);
    const imported = await createUiImporter().import({
      source: 'guide.ui.html',
      readSource: async () => ({ ok: true as const, value: new TextEncoder().encode(html) }),
      readSibling: async (path) => ({
        ok: true as const,
        value: new TextEncoder().encode(path === 'guide.ui.css' ? css : ''),
      }),
      decodeImage: async () => {
        throw new Error('the template UI has no image companion');
      },
      subAssets: meta.subAssets,
      importSettings: meta.importSettings,
    });
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.value.sourceDependencies).toEqual(['guide.ui.html', 'guide.ui.css']);
      expect(imported.value.assets[0]?.payload).toMatchObject({ html, css });
    }
  });

  it('defines camera-relative directions without left/right or front/back ambiguity', () => {
    expect(horizontalCameraAxes(0)).toEqual({ forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0 });
    const left = cameraRelativeMove(0, -1, 0);
    const right = cameraRelativeMove(0, 1, 0);
    expect(left.x).toBe(-1);
    expect(left.z).toBeCloseTo(0);
    expect(right.x).toBe(1);
    expect(right.z).toBeCloseTo(0);
    const quarterTurn = cameraRelativeMove(Math.PI / 2, 0, 1);
    expect(quarterTurn.x).toBeCloseTo(1);
    expect(quarterTurn.z).toBeCloseTo(0);
    expect(facingYaw(0, -1)).toBeCloseTo(0);
    expect(facingYaw(1, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it('uses locked-pointer deltas with a bounded camera pitch', () => {
    expect(integratePointerLook(0, 0, 100, 0).yaw).toBeGreaterThan(0);
    expect(integratePointerLook(0, 0, 0, -100_000).pitch).toBe(MIN_CAMERA_PITCH);
    expect(integratePointerLook(0, 0, 0, 100_000).pitch).toBe(MAX_CAMERA_PITCH);
  });

  it('builds a generated HDR analytic daylight', async () => {
    const daylight = (await build(environmentPack))['environment/daylight'] as {
      readonly kind: string;
      readonly width: number;
      readonly height: number;
      readonly format: string;
      readonly data: Uint8Array;
    };
    expect(daylight).toMatchObject({ kind: 'equirect', width: 256, height: 128, format: 'rgba16float' });
    expect(daylight.data.byteLength).toBe(256 * 128 * 8);
    expect(daylight.data.some((value) => value !== 0)).toBe(true);
  });

  it('builds a three-submesh, three-material skinned humanoid and walk clip', async () => {
    const outputs = await build(characterPack);
    const mesh = outputs['mesh/player'] as {
      readonly indices: Uint32Array;
      readonly attributes: {
        readonly position?: Float32Array;
        readonly skinIndex?: Uint16Array;
        readonly skinWeight?: Float32Array;
      };
      readonly submeshes: readonly { readonly materialSlot: number; readonly indexCount: number }[];
      readonly materialSlots: readonly { readonly slotName: string; readonly defaultMaterial?: Uint8Array }[];
    };
    expect(mesh.attributes.skinIndex).toBeInstanceOf(Uint16Array);
    expect(mesh.attributes.skinWeight).toBeInstanceOf(Float32Array);
    expect(mesh.submeshes.map((submesh) => submesh.materialSlot)).toEqual([0, 1, 2]);
    expect(mesh.submeshes.every((submesh) => submesh.indexCount > 0)).toBe(true);
    expect(mesh.materialSlots.map((slot) => slot.slotName)).toEqual(['Light Gray', 'Mid Gray', 'Dark Gray']);
    expect(mesh.materialSlots.every((slot) => slot.defaultMaterial?.byteLength === 16)).toBe(true);
    const vertexCount = (mesh.attributes.position?.length ?? 0) / 3;
    const positions = mesh.attributes.position ?? new Float32Array();
    const xs = Array.from({ length: vertexCount }, (_, index) => positions[index * 3] ?? 0);
    const ys = Array.from({ length: vertexCount }, (_, index) => positions[index * 3 + 1] ?? 0);
    expect(Math.min(...xs)).toBeLessThan(-0.9);
    expect(Math.max(...xs)).toBeGreaterThan(0.9);
    expect(Math.min(...ys)).toBeLessThan(-1);
    expect(Math.max(...ys)).toBeGreaterThan(1.15);
    const neighbors = Array.from({ length: vertexCount }, () => new Set<number>());
    const edgeUseCounts = new Map<string, number>();
    let maximumRestEdgeLength = 0;
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
      for (let index = 0; index < 3; index += 1) {
        const from = triangle[index];
        const to = triangle[(index + 1) % 3];
        if (from !== undefined && to !== undefined) {
          neighbors[from]?.add(to);
          neighbors[to]?.add(from);
          const edgeKey = from < to ? `${from}:${to}` : `${to}:${from}`;
          edgeUseCounts.set(edgeKey, (edgeUseCounts.get(edgeKey) ?? 0) + 1);
          maximumRestEdgeLength = Math.max(
            maximumRestEdgeLength,
            Math.hypot(
              (positions[from * 3] ?? 0) - (positions[to * 3] ?? 0),
              (positions[from * 3 + 1] ?? 0) - (positions[to * 3 + 1] ?? 0),
              (positions[from * 3 + 2] ?? 0) - (positions[to * 3 + 2] ?? 0),
            ),
          );
        }
      }
    }
    const visited = new Set<number>();
    const pending = [mesh.indices[0] ?? 0];
    while (pending.length > 0) {
      const vertex = pending.pop();
      if (vertex === undefined || visited.has(vertex)) continue;
      visited.add(vertex);
      for (const neighbor of neighbors[vertex] ?? []) pending.push(neighbor);
    }
    expect(visited.size).toBe(vertexCount);
    const boundaryEdges = [...edgeUseCounts.entries()].filter(([, count]) => count === 1);
    const boundaryEdgeCount = boundaryEdges.length;
    const nonManifoldEdgeCount = [...edgeUseCounts.values()].filter((count) => count > 2).length;
    const boundarySummary = boundaryEdges.slice(0, 12).map(([key]) =>
      key.split(':').map((value) => {
        const vertex = Number(value);
        return Array.from(positions.slice(vertex * 3, vertex * 3 + 3));
      }),
    );
    expect(maximumRestEdgeLength).toBeLessThan(0.09);
    expect(boundaryEdgeCount, JSON.stringify(boundarySummary)).toBe(0);
    expect(nonManifoldEdgeCount).toBe(0);
    const weights = mesh.attributes.skinWeight;
    expect(weights).toBeInstanceOf(Float32Array);
    let blendedVertexCount = 0;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      let sum = 0;
      let nonZero = 0;
      for (let lane = 0; lane < 4; lane += 1) {
        const weight = weights?.[vertex * 4 + lane] ?? 0;
        sum += weight;
        if (weight > 0.00001) nonZero += 1;
      }
      expect(sum).toBeCloseTo(1, 5);
      if (nonZero > 1) blendedVertexCount += 1;
    }
    expect(blendedVertexCount).toBeGreaterThan(vertexCount * 0.3);
    expect(outputs['rig/player-skeleton']).toMatchObject({ kind: 'skeleton', jointCount: 14 });
    expect(outputs['rig/player-skin']).toMatchObject({ kind: 'skin' });
    expect(outputs['animation/player-walk']).toMatchObject({
      kind: 'animation-clip',
      duration: 1,
      channels: expect.arrayContaining([expect.objectContaining({ property: 'translation' })]),
    });
    const stretch = maximumAnimatedEdgeStretch(
      mesh,
      outputs['rig/player-skeleton'] as { readonly inverseBindMatrices: Float32Array },
      outputs['animation/player-walk'] as Parameters<typeof maximumAnimatedEdgeStretch>[2],
    );
    expect(stretch.ratio, stretch.detail).toBeLessThan(3);
  });

  it('restores the three fantasy meshes with explicit multi-material submeshes', async () => {
    const outputs = await build(fantasyMeshesPack);
    expect(Object.keys(outputs)).toEqual([
      'mesh/klein-bottle',
      'mesh/trefoil-knot',
      'mesh/astral-bloom',
    ]);
    for (const mesh of Object.values(outputs) as {
      readonly submeshes: readonly { readonly materialSlot: number; readonly indexCount: number }[];
      readonly materialSlots: readonly unknown[];
    }[]) {
      expect(mesh.submeshes.map((submesh) => submesh.materialSlot)).toEqual([0, 1, 2]);
      expect(mesh.submeshes.every((submesh) => submesh.indexCount > 0)).toBe(true);
      expect(mesh.materialSlots).toHaveLength(3);
    }
  });

  it('routes visible player passes through skinning and keeps the depth-only shadow pass', async () => {
    const outputs = await build(materialsPack);
    expect(Object.keys(outputs)).toHaveLength(14);
    const playerGrayLevels: number[] = [];
    for (const key of ['material/player-body', 'material/player-cloth', 'material/player-accent']) {
      const material = outputs[key] as {
        readonly passes: readonly {
          readonly name: string;
          readonly program: { readonly module: string; readonly fragmentEntry?: string };
        }[];
        readonly values: Readonly<Record<string, unknown>>;
      };
      expect(
        material.passes
          .filter((pass) => pass.name !== 'shadow-caster')
          .every((pass) => pass.program.module === 'forgeax::pbr-skin'),
      ).toBe(true);
      const deferred = material.passes.find((pass) => pass.name === 'deferred');
      if (deferred === undefined) {
        expect(material.passes.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
      } else {
        expect(deferred.program.fragmentEntry).toBe('fs_gbuffer');
      }
      expect(material.passes.find((pass) => pass.name === 'shadow-caster')?.program.module).toBe(
        'forgeax::default-shadow-caster',
      );
      const baseColor = material.values.baseColor as readonly number[];
      expect(Math.max(...baseColor.slice(0, 3)) - Math.min(...baseColor.slice(0, 3))).toBe(0);
      playerGrayLevels.push(baseColor[0] ?? 0);
      expect(material.values.emissive).toBeUndefined();
      expect(material.values.emissiveIntensity).toBeUndefined();
    }
    expect(Math.max(...playerGrayLevels) - Math.min(...playerGrayLevels)).toBeLessThanOrEqual(0.08);
    const rustedIron = outputs['material/rusted-iron'] as {
      readonly passes: readonly { readonly program: { readonly module: string } }[];
      readonly parameters: readonly { readonly name: string; readonly type: string }[];
      readonly values: { readonly ironColor: readonly number[] };
    };
    expect(rustedIron.passes[0]?.program.module).toBe('forgeax_material::standard');
    expect(rustedIron.parameters).toContainEqual({ name: 'ironColor', type: 'color' });
    expect(rustedIron.values).not.toHaveProperty('baseColorTexture');
    expect(Math.min(...rustedIron.values.ironColor.slice(0, 3))).toBeGreaterThanOrEqual(0.38);

    const geometry = await build(geometryPack);
    expect(Object.keys(geometry)).toHaveLength(8);
    const ramp = geometry['mesh/ramp'] as {
      readonly materialSlots: readonly { readonly defaultMaterial?: Uint8Array }[];
    };
    expect(ramp.materialSlots[0]?.defaultMaterial).toEqual(RUSTED_IRON_MATERIAL_GUID);
  });

  it('authors physics on the player and every visible walkable obstacle', async () => {
    const scene = (await build(scenePack))['scene/showcase'] as {
      readonly sourceKey: string;
      readonly skinGuids: readonly string[];
      readonly entities: readonly { readonly components: Record<string, Record<string, unknown>> }[];
    };
    expect(scene.sourceKey).toBe('scene/showcase');
    const components = scene.entities.map((entity) => entity.components);
    const player = components.find((entry) => entry.Name?.value === 'Player');
    expect(player).toMatchObject({
      RigidBody: { type: 2 },
      Collider: { radius: 0.38, halfHeight: 0.55 },
      CharacterController: { autoStepMaxHeight: 0.32, snapToGroundDist: 0.24 },
    });
    for (const name of [
      'Ground',
      'Warm Stone Pedestal',
      'Mirror Sphere',
      'Lacquer Collision Cube',
      'Mirror Torus',
      'Sandstone Step',
      'Rusted Iron Ramp',
      'Klein Bottle',
      'Trefoil Knot',
      'Astral Bloom',
    ]) {
      const object = components.find((entry) => entry.Name?.value === name);
      expect(object?.RigidBody).toMatchObject({ type: 0 });
      expect(object?.Collider).toBeDefined();
    }
    const ramp = components.find((entry) => entry.Name?.value === 'Rusted Iron Ramp');
    const rampPosition = ramp?.Transform?.pos as readonly number[] | undefined;
    const playerPosition = player?.Transform?.pos as readonly number[] | undefined;
    expect(rampPosition?.[0]).toBeCloseTo(-2.2);
    expect(rampPosition?.[2]).toBeCloseTo(playerPosition?.[2] ?? 0);
    expect(Math.abs((rampPosition?.[0] ?? 0) - (playerPosition?.[0] ?? 0))).toBeLessThan(3);
    expect(components.find((entry) => entry.Name?.value === 'Player Body')?.Skin).toBeDefined();
    expect(scene.skinGuids).toHaveLength(1);
    expect(components.find((entry) => entry.DirectionalLight)?.DirectionalLight).toMatchObject({
      castShadow: true,
      cascadeCount: 3,
    });
    expect(components.some((entry) => entry.Skylight !== undefined)).toBe(true);
    expect(components.some((entry) => entry.PointLight !== undefined)).toBe(true);
    expect(components.some((entry) => entry.Camera !== undefined)).toBe(true);
  });
});
