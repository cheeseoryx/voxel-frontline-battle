import { deriveAnimationTargetId } from '@forgeax/engine/animation';
import { packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
import { box3 } from '@forgeax/engine/math';
import { definePack } from '@forgeax/engine/pack/source';
import type { AnimationClip, MeshAsset, SkeletonAsset, SkinAsset, VertexAttributeMap } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS } from './shared/asset-refs.ts';
import { PLAYER_JOINT_NAMES, PLAYER_RIG } from './player/player-rig.ts';

type Vec3 = readonly [number, number, number];
const GRID = { x: 40, y: 50, z: 24 } as const;
// Keep the sampled volume outside the complete surface; clipping it creates open head or foot caps.
const MIN: Vec3 = [-1.02, -1.18, -0.46];
const MAX: Vec3 = [1.02, 1.34, 0.46];
const TETRAHEDRA = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]] as const;

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function smoothstep(a: number, b: number, value: number): number {
  const t = clamp01((value - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function smoothMin(a: number, b: number, radius: number): number {
  const h = clamp01(0.5 + (b - a) / (2 * radius));
  return b * (1 - h) + a * h - radius * h * (1 - h);
}
function ellipsoid(p: Vec3, c: Vec3, r: Vec3): number {
  return (Math.hypot((p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]) - 1) * Math.min(...r);
}
function capsule(p: Vec3, a: Vec3, b: Vec3, radius: number): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]] as const;
  const t = clamp01((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t) - radius;
}
function smoothUnion(shapes: readonly number[], radius: number): number {
  let distance = shapes[0] ?? 1;
  for (let index = 1; index < shapes.length; index += 1) distance = smoothMin(distance, shapes[index] ?? distance, radius);
  return distance;
}

function playerSurface(p: Vec3): number {
  const body = smoothUnion([
    ellipsoid(p, [0, 0.31, 0], [0.43, 0.5, 0.25]), ellipsoid(p, [0, -0.16, 0], [0.38, 0.27, 0.24]),
    capsule(p, [0, 0.62, 0], [0, 0.76, 0], 0.14), ellipsoid(p, [0, 0.94, -0.015], [0.27, 0.3, 0.25]),
  ], 0.075);
  const leftArm = smoothUnion([
    capsule(p, [-0.3, 0.53, 0], [-0.63, 0.23, 0], 0.145), capsule(p, [-0.63, 0.23, 0], [-0.8, -0.08, -0.025], 0.12), ellipsoid(p, [-0.82, -0.16, -0.035], [0.135, 0.17, 0.13]),
  ], 0.075);
  const rightArm = smoothUnion([
    capsule(p, [0.3, 0.53, 0], [0.63, 0.23, 0], 0.145), capsule(p, [0.63, 0.23, 0], [0.8, -0.08, -0.025], 0.12), ellipsoid(p, [0.82, -0.16, -0.035], [0.135, 0.17, 0.13]),
  ], 0.075);
  const leftLeg = smoothUnion([
    capsule(p, [-0.17, -0.25, 0], [-0.18, -0.61, 0.01], 0.17), capsule(p, [-0.18, -0.58, 0.01], [-0.18, -0.89, -0.055], 0.135), ellipsoid(p, [-0.19, -0.96, -0.14], [0.15, 0.13, 0.28]),
  ], 0.055);
  const rightLeg = smoothUnion([
    capsule(p, [0.17, -0.25, 0], [0.18, -0.61, 0.01], 0.17), capsule(p, [0.18, -0.58, 0.01], [0.18, -0.89, -0.055], 0.135), ellipsoid(p, [0.19, -0.96, -0.14], [0.15, 0.13, 0.28]),
  ], 0.055);
  return Math.min(
    smoothMin(body, leftArm, 0.055),
    smoothMin(body, rightArm, 0.055),
    smoothMin(body, leftLeg, 0.045),
    smoothMin(body, rightLeg, 0.045),
  );
}

function averageCorners(corners: readonly Vec3[], indices: readonly number[]): Vec3 {
  const sum = [0, 0, 0];
  for (const index of indices) {
    const corner = corners[index] ?? [0, 0, 0];
    sum[0] += corner[0]; sum[1] += corner[1]; sum[2] += corner[2];
  }
  const divisor = indices.length || 1;
  return [sum[0] / divisor, sum[1] / divisor, sum[2] / divisor];
}

function jointInfluences(point: Vec3): readonly (readonly [number, number])[] {
  const [x, y] = point;
  const weights = new Float32Array(PLAYER_RIG.length);
  if (y < -0.2) {
    const a = smoothstep(-0.2, -0.42, y); const b = smoothstep(-0.48, -0.72, y); const c = smoothstep(-0.79, -0.96, y);
    const right = smoothstep(-0.06, 0.06, x), left = 1 - right;
    const thighWeight = a * (1 - b), shinWeight = b * (1 - c), footWeight = c;
    weights[0] = 1 - a;
    weights[8] = thighWeight * left; weights[9] = shinWeight * left; weights[10] = footWeight * left;
    weights[11] = thighWeight * right; weights[12] = shinWeight * right; weights[13] = footWeight * right;
  } else if (y > 0.68) {
    const head = smoothstep(0.68, 0.86, y); weights[2] = 1 - head; weights[3] = head;
  } else {
    const spine = smoothstep(-0.2, 0.26, y); const chest = smoothstep(0.22, 0.54, y);
    weights[0] = 1 - spine; weights[1] = spine * (1 - chest); weights[2] = chest;
  }
  const side = x < 0 ? -1 : 1;
  const armDistance = Math.min(
    capsule(point, [side * 0.3, 0.53, 0], [side * 0.63, 0.23, 0], 0),
    capsule(point, [side * 0.63, 0.23, 0], [side * 0.82, -0.16, -0.035], 0),
  );
  const armBlend = smoothstep(0.31, 0.13, armDistance) * smoothstep(0.22, 0.54, Math.abs(x));
  if (armBlend > 0) {
    const upper = x < 0 ? 4 : 6, forearm = x < 0 ? 5 : 7;
    const progress = clamp01((Math.abs(x) - 0.3) / 0.53);
    const forearmWeight = smoothstep(0.38, 0.72, progress);
    const upperWeight = (1 - forearmWeight) * smoothstep(0, 0.28, progress);
    const chestWeight = 1 - upperWeight - forearmWeight;
    for (let joint = 0; joint < weights.length; joint += 1) weights[joint] = (weights[joint] ?? 0) * (1 - armBlend);
    weights[2] += chestWeight * armBlend;
    weights[upper] += upperWeight * armBlend;
    weights[forearm] += forearmWeight * armBlend;
  }
  const found: [number, number][] = [];
  for (let joint = 0; joint < weights.length; joint += 1) { const weight = weights[joint] ?? 0; if (weight > 0.00001) found.push([joint, weight]); }
  found.sort((a, b) => b[1] - a[1]);
  const selected = found.slice(0, 4), selectedTotal = selected.reduce((sum, [, weight]) => sum + weight, 0);
  return selected.map(([joint, weight]) => [joint, weight / selectedTotal] as const);
}

function materialSlot([x, y]: Vec3): number {
  if (y > 0.7 || (Math.abs(x) > 0.72 && y < 0.08)) return 0;
  if ((y > -0.24 && y < -0.12) || y < -0.79) return 2;
  return 1;
}

function playerMesh(): MeshAsset {
  const nx = GRID.x + 1, ny = GRID.y + 1, nz = GRID.z + 1;
  const gridIndex = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const pointAt = (x: number, y: number, z: number): Vec3 => [MIN[0] + (MAX[0] - MIN[0]) * x / GRID.x, MIN[1] + (MAX[1] - MIN[1]) * y / GRID.y, MIN[2] + (MAX[2] - MIN[2]) * z / GRID.z];
  const values = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z += 1) for (let y = 0; y < ny; y += 1) for (let x = 0; x < nx; x += 1) values[gridIndex(x, y, z)] = playerSurface(pointAt(x, y, z));
  const gradients = new Float32Array(values.length * 3);
  const spacing: Vec3 = [(MAX[0] - MIN[0]) / GRID.x, (MAX[1] - MIN[1]) / GRID.y, (MAX[2] - MIN[2]) / GRID.z];
  for (let z = 0; z < nz; z += 1) for (let y = 0; y < ny; y += 1) for (let x = 0; x < nx; x += 1) {
    const id = gridIndex(x, y, z), offset = id * 3;
    const x0 = Math.max(0, x - 1), x1 = Math.min(GRID.x, x + 1);
    const y0 = Math.max(0, y - 1), y1 = Math.min(GRID.y, y + 1);
    const z0 = Math.max(0, z - 1), z1 = Math.min(GRID.z, z + 1);
    gradients[offset] = ((values[gridIndex(x1, y, z)] ?? 0) - (values[gridIndex(x0, y, z)] ?? 0)) / ((x1 - x0) * spacing[0]);
    gradients[offset + 1] = ((values[gridIndex(x, y1, z)] ?? 0) - (values[gridIndex(x, y0, z)] ?? 0)) / ((y1 - y0) * spacing[1]);
    gradients[offset + 2] = ((values[gridIndex(x, y, z1)] ?? 0) - (values[gridIndex(x, y, z0)] ?? 0)) / ((z1 - z0) * spacing[2]);
  }

  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], tangents: number[] = [], skinIndices: number[] = [], skinWeights: number[] = [];
  const groups: number[][] = [[], [], []]; const edgeVertices = new Map<string, number>();
  const vertexOnEdge = (a: number, b: number, corners: readonly Vec3[], ids: readonly number[]) => {
    const ga = ids[a] ?? 0, gb = ids[b] ?? 0, key = ga < gb ? `${ga}:${gb}` : `${gb}:${ga}`;
    const cached = edgeVertices.get(key); if (cached !== undefined) return cached;
    const va = values[ga] ?? 0, vb = values[gb] ?? 0, t = Math.abs(va - vb) < 1e-8 ? 0.5 : clamp01(va / (va - vb));
    const pa = corners[a] ?? [0, 0, 0], pb = corners[b] ?? [0, 0, 0];
    const point: Vec3 = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
    const gradientA = ga * 3, gradientB = gb * 3;
    const normal: Vec3 = [
      (gradients[gradientA] ?? 0) + ((gradients[gradientB] ?? 0) - (gradients[gradientA] ?? 0)) * t,
      (gradients[gradientA + 1] ?? 0) + ((gradients[gradientB + 1] ?? 0) - (gradients[gradientA + 1] ?? 0)) * t,
      (gradients[gradientA + 2] ?? 0) + ((gradients[gradientB + 2] ?? 0) - (gradients[gradientA + 2] ?? 0)) * t,
    ];
    const index = positions.length / 3;
    positions.push(...point); normals.push(...normal); uvs.push(0.5 + Math.atan2(point[2], point[0]) / (Math.PI * 2), (point[1] - MIN[1]) / (MAX[1] - MIN[1])); tangents.push(0, 0, 0, 1);
    const influences = jointInfluences(point);
    for (let lane = 0; lane < 4; lane += 1) { skinIndices.push(influences[lane]?.[0] ?? 0); skinWeights.push(influences[lane]?.[1] ?? 0); }
    edgeVertices.set(key, index); return index;
  };
  const addTriangle = (a: number, b: number, c: number, outwardHint: Vec3) => {
    const p = (i: number): Vec3 => [positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0];
    const pa = p(a), pb = p(b), pc = p(c);
    const cross: Vec3 = [(pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1]), (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]), (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])];
    const outward = cross[0] * outwardHint[0] + cross[1] * outwardHint[1] + cross[2] * outwardHint[2] >= 0;
    const centroid: Vec3 = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
    groups[materialSlot(centroid)]?.push(a, outward ? b : c, outward ? c : b);
  };
  for (let z = 0; z < GRID.z; z += 1) for (let y = 0; y < GRID.y; y += 1) for (let x = 0; x < GRID.x; x += 1) {
    const coordinates = [[x,y,z],[x+1,y,z],[x+1,y+1,z],[x,y+1,z],[x,y,z+1],[x+1,y,z+1],[x+1,y+1,z+1],[x,y+1,z+1]] as const;
    const ids = coordinates.map(([gx,gy,gz]) => gridIndex(gx,gy,gz)), corners = coordinates.map(([gx,gy,gz]) => pointAt(gx,gy,gz));
    for (const tetra of TETRAHEDRA) {
      const inside = tetra.filter((corner) => (values[ids[corner] ?? 0] ?? 0) <= 0), outside = tetra.filter((corner) => (values[ids[corner] ?? 0] ?? 0) > 0);
      if (inside.length === 0 || inside.length === 4) continue;
      const insideCenter = averageCorners(corners, inside), outsideCenter = averageCorners(corners, outside);
      const outwardHint: Vec3 = [outsideCenter[0] - insideCenter[0], outsideCenter[1] - insideCenter[1], outsideCenter[2] - insideCenter[2]];
      if (inside.length === 1 || inside.length === 3) {
        const singleton = inside.length === 1 ? inside[0] : outside[0], others = inside.length === 1 ? outside : inside;
        if (singleton !== undefined && others.length === 3) addTriangle(vertexOnEdge(singleton, others[0] ?? 0, corners, ids), vertexOnEdge(singleton, others[1] ?? 0, corners, ids), vertexOnEdge(singleton, others[2] ?? 0, corners, ids), outwardHint);
      } else {
        const [a,b] = inside, [c,d] = outside; if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
        const ac = vertexOnEdge(a,c,corners,ids), ad = vertexOnEdge(a,d,corners,ids), bc = vertexOnEdge(b,c,corners,ids), bd = vertexOnEdge(b,d,corners,ids); addTriangle(ac,bc,bd,outwardHint); addTriangle(ac,bd,ad,outwardHint);
      }
    }
  }
  const vertexCount = positions.length / 3;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const nx = normals[vertex * 3] ?? 0, ny = normals[vertex * 3 + 1] ?? 0, nz = normals[vertex * 3 + 2] ?? 0;
    const normalLength = Math.hypot(nx, ny, nz) || 1;
    const normalX = nx / normalLength, normalY = ny / normalLength, normalZ = nz / normalLength;
    normals[vertex * 3] = normalX; normals[vertex * 3 + 1] = normalY; normals[vertex * 3 + 2] = normalZ;
    const tangentLength = Math.hypot(normalZ, normalX) || 1;
    tangents[vertex * 4] = normalZ / tangentLength; tangents[vertex * 4 + 1] = 0; tangents[vertex * 4 + 2] = -normalX / tangentLength;
  }
  const attributes: VertexAttributeMap = { position: new Float32Array(positions), normal: new Float32Array(normals), uv: new Float32Array(uvs), tangent: new Float32Array(tangents), skinIndex: new Uint16Array(skinIndices), skinWeight: new Float32Array(skinWeights) };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount); if (!packed.ok) throw packed.error;
  const indices: number[] = []; const submeshes = groups.map((group, materialSlot) => { const indexOffset = indices.length; indices.push(...group); return { indexOffset, indexCount: group.length, vertexCount, topology: 'triangle-list' as const, materialSlot }; });
  return { kind: 'mesh', vertices: packed.value.vertices, indices: new Uint32Array(indices), attributes, aabb: box3.fromPositions(box3.create(), positions), submeshes, materialSlots: [
    { slotName: 'Light Gray', sourceKey: 'game-3d:player-body', defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/player-body') },
    { slotName: 'Mid Gray', sourceKey: 'game-3d:player-cloth', defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/player-cloth') },
    { slotName: 'Dark Gray', sourceKey: 'game-3d:player-accent', defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/player-accent') },
  ] };
}

function playerSkeleton(): SkeletonAsset {
  const matrices = new Float32Array(PLAYER_RIG.length * 16);
  for (let joint = 0; joint < PLAYER_RIG.length; joint += 1) { const world = PLAYER_RIG[joint]?.world ?? [0,0,0], offset = joint * 16; matrices[offset] = matrices[offset+5] = matrices[offset+10] = matrices[offset+15] = 1; matrices[offset+12] = -world[0]; matrices[offset+13] = -world[1]; matrices[offset+14] = -world[2]; }
  return { kind: 'skeleton', inverseBindMatrices: matrices, jointCount: PLAYER_RIG.length };
}
function targetPath(joint: number): readonly string[] { const names: string[] = []; let cursor = joint; while (cursor >= 0) { const entry = PLAYER_RIG[cursor]; if (entry === undefined) break; names.unshift(entry.name); cursor = entry.parent; } return ['Player', ...names]; }
function rotationChannel(joint: number, axis: Vec3, angles: readonly [number,number,number,number,number]): AnimationClip['channels'][number] {
  const output: number[] = []; for (const angle of angles) { const sine = Math.sin(angle / 2); output.push(axis[0]*sine, axis[1]*sine, axis[2]*sine, Math.cos(angle/2)); }
  return { targetId: deriveAnimationTargetId(targetPath(joint)), property: 'rotation', sampler: { input: new Float32Array([0,0.25,0.5,0.75,1]), output: new Float32Array(output), interpolation: 'LINEAR' } };
}
function walkClip(): AnimationClip {
  const opposite = (a: number) => [0,a,0,-a,0] as const, forward = (a: number) => [0,-a,0,a,0] as const;
  return { kind: 'animation-clip', duration: 1, channels: [
    { targetId: deriveAnimationTargetId(targetPath(0)), property: 'translation', sampler: { input: new Float32Array([0,0.25,0.5,0.75,1]), output: new Float32Array([0,-0.12,0, 0.018,-0.085,0, 0,-0.12,0, -0.018,-0.085,0, 0,-0.12,0]), interpolation: 'LINEAR' } },
    rotationChannel(0,[0,1,0],opposite(0.07)), rotationChannel(1,[0,0,1],forward(0.09)), rotationChannel(2,[0,1,0],opposite(0.1)), rotationChannel(3,[0,0,1],forward(0.045)),
    rotationChannel(4,[1,0,0],opposite(0.62)), rotationChannel(5,[1,0,0],[0.18,0.38,0.18,0.08,0.18]), rotationChannel(6,[1,0,0],forward(0.62)), rotationChannel(7,[1,0,0],[0.18,0.08,0.18,0.38,0.18]),
    rotationChannel(8,[1,0,0],forward(0.48)), rotationChannel(9,[1,0,0],[0.05,0.08,0.05,0.42,0.05]), rotationChannel(10,[1,0,0],[0,0.18,0,-0.12,0]),
    rotationChannel(11,[1,0,0],opposite(0.48)), rotationChannel(12,[1,0,0],[0.05,0.42,0.05,0.08,0.05]), rotationChannel(13,[1,0,0],[0,-0.12,0,0.18,0]),
  ] };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.character,
  name: 'Game 3D / Character',
  build: () =>
    ok({
      'mesh/player': playerMesh(),
      'rig/player-skeleton': playerSkeleton(),
      'rig/player-skin': {
        kind: 'skin',
        skeletonGuid: guidText(assetGuid(PACKAGE_IDS.character, 'rig/player-skeleton')),
        jointPaths: [...PLAYER_JOINT_NAMES],
      } satisfies SkinAsset,
      'animation/player-walk': walkClip(),
    }),
});
