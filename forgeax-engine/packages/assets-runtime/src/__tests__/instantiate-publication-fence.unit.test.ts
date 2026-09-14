import { World } from '@forgeax/engine-ecs';
import {
  type AssetPublicationEnvelope,
  type SceneAsset,
  unwrapHandle,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { AssetRegistry } from '../asset-registry';
import { resolveMountsRec, scenePublicationFenceFromRegistry } from '../registry/instantiate';
import { createScenePublicationFence } from '../registry/scene-publication-fence';

const SCENE_GUID = '019ffdb4-1000-7000-8000-000000000008';

function publication(): AssetPublicationEnvelope {
  return {
    schemaVersion: 'asset-publication/1',
    sourcePath: 'assets/procedural-showcase.pack.ts',
    sourceRevision: 'sha256:scene-source',
    generation: 17,
    digest: 'sha256:scene-package',
    outputSetDigest: 'sha256:scene-outputs',
    outputs: [
      {
        guid: SCENE_GUID,
        sourceKey: 'scene/main',
        kind: 'scene',
        digest: 'sha256:scene',
        refs: [],
      },
    ],
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: 'assets/procedural-showcase.pack.ts',
      sourceRevision: 'sha256:scene-source',
      inputFingerprint: 'sha256:scene-source',
      outputDigest: 'sha256:scene-package',
      outputSetDigest: 'sha256:scene-outputs',
      externalEvidence: [],
    },
    externalEvidence: [],
  };
}

describe('resolveMountsRec publication fence identity', () => {
  it('resolves a numeric mount source through origin identity before validating its fence', () => {
    const world = new World();
    const child: SceneAsset = { kind: 'scene', entities: [] };
    const source = unwrapHandle(world.allocSharedRef('SceneAsset', child));
    const fence = createScenePublicationFence(publication());
    expect(fence.ok).toBe(true);
    if (!fence.ok) return;
    const registry = {
      assetCatalog: new Map(),
      catalogSnapshot: () => ({
        entries: [
          {
            guid: SCENE_GUID,
            kind: 'scene',
            sourcePath: 'assets/procedural-showcase.pack.ts',
            packageUrl: '/assets/scene.pack.json',
            publication: publication(),
          },
        ],
      }),
      _guidForAsset: (asset: unknown) => (asset === child ? SCENE_GUID : undefined),
    } as unknown as AssetRegistry;
    const result = resolveMountsRec(
      registry,
      [
        {
          localId: 0 as never,
          source,
          memberFirst: 0 as never,
          memberCount: 0,
          publicationFence: fence.value,
        },
      ],
      world,
      new Set(),
    );
    expect(result).toMatchObject({ ok: true, value: [{ source }] });
  });

  it('uses the matching catalog publication tuple when a persisted numeric source has no live handle', () => {
    const world = new World();
    const fence = createScenePublicationFence(publication());
    expect(fence.ok).toBe(true);
    if (!fence.ok) return;
    const entries = [
      {
        guid: SCENE_GUID,
        kind: 'scene',
        sourcePath: 'assets/procedural-showcase.pack.ts',
        packageUrl: '/assets/scene.pack.json',
        publication: publication(),
      },
    ];
    const registry = {
      assetCatalog: new Map(),
      catalogSnapshot: () => ({ entries }),
      _guidForAsset: () => undefined,
    } as unknown as AssetRegistry;
    const result = resolveMountsRec(
      registry,
      [
        {
          localId: 0 as never,
          source: 6,
          memberFirst: 0 as never,
          memberCount: 0,
          publicationFence: fence.value,
        },
      ],
      world,
      new Set(),
    );
    expect(result).toMatchObject({ ok: true, value: [{ source: 6 }] });
  });

  it('uses the Play pack-index publication tuple when no CatalogReplica is attached', () => {
    const world = new World();
    const fence = createScenePublicationFence(publication());
    expect(fence.ok).toBe(true);
    if (!fence.ok) return;
    const registry = {
      assetCatalog: new Map(),
      catalogSnapshot: () => undefined,
      packIndexCache: new Map([
        [
          SCENE_GUID,
          {
            guid: SCENE_GUID,
            kind: 'scene',
            sourcePath: 'assets/procedural-showcase.pack.ts',
            packageUrl: '/assets/scene.pack.json',
            publication: publication(),
          },
        ],
      ]),
      _guidForAsset: () => undefined,
    } as unknown as AssetRegistry;
    const result = resolveMountsRec(
      registry,
      [
        {
          localId: 0 as never,
          source: 6,
          memberFirst: 0 as never,
          memberCount: 0,
          publicationFence: fence.value,
        },
      ],
      world,
      new Set(),
    );
    expect(result).toMatchObject({ ok: true, value: [{ source: 6 }] });
  });

  it('prefers the complete pack-index tuple during a CatalogReplica handoff', () => {
    const world = new World();
    const currentSourcePath = 'assets/current.glb';
    const currentPublication = {
      ...publication(),
      sourcePath: currentSourcePath,
      receipt: { ...publication().receipt, sourcePath: currentSourcePath },
    };
    const fence = createScenePublicationFence(currentPublication);
    expect(fence.ok).toBe(true);
    if (!fence.ok) return;
    const registry = {
      assetCatalog: new Map(),
      // The replica may still expose the prior complete tuple while the
      // latest pack-index has already been hydrated after a source write.
      catalogSnapshot: () => ({
        entries: [
          {
            guid: SCENE_GUID,
            kind: 'scene',
            sourcePath: publication().sourcePath,
            packageUrl: '/assets/scene.pack.json',
            publication: publication(),
          },
        ],
      }),
      packIndexCache: new Map([
        [
          SCENE_GUID,
          {
            guid: SCENE_GUID,
            kind: 'scene',
            sourcePath: currentSourcePath,
            packageUrl: '/assets/current.pack.json',
            publication: currentPublication,
          },
        ],
      ]),
      _guidForAsset: () => undefined,
    } as unknown as AssetRegistry;
    const result = resolveMountsRec(
      registry,
      [
        {
          localId: 0 as never,
          source: 6,
          memberFirst: 0 as never,
          memberCount: 0,
          publicationFence: fence.value,
        },
      ],
      world,
      new Set(),
    );
    expect(result).toMatchObject({ ok: true, value: [{ source: 6 }] });
    expect(scenePublicationFenceFromRegistry(registry, SCENE_GUID)).toEqual(fence);
  });
});
