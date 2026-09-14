import { AssetGuid, definePack, definePackageId, PackageId } from '@forgeax/engine-pack/source';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { ScriptablePackAssetSnapshotSource } from '../scriptable-pack.js';
import { AssetOutputProducerRegistry } from '../scriptable-pack.js';
import { buildScriptablePack, buildScriptablePackWorklist } from '../scriptable-pack-build.js';
import { produceScriptablePackProducts } from '../scriptable-pack-host.js';

function id(value: string) {
  const result = PackageId.parse(value);
  if (!result.ok) throw result.error;
  return result.value;
}

function scene() {
  return { kind: 'scene' as const, entities: [], mounts: [] };
}

function producers() {
  const registry = new AssetOutputProducerRegistry();
  registry.register({
    kind: 'scene',
    version: 'test',
    produce: ({ asset }) => ok({ payload: asset as never, refs: [], artifacts: {} }),
  });
  return registry;
}

describe('ScriptablePack import bridge with optional parameters', () => {
  it('uses the subject packageId and dynamic sourceKey output map', async () => {
    const packageId = definePackageId('01900000-0000-7000-8000-000000000040');
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      parameters: [{ name: 'count', type: 'u32', default: 1, minimum: 1 }] as const,
      build: ({ values }) =>
        ok(
          Object.fromEntries(
            Array.from({ length: values.count }, (_, index) => [`scene/${index}`, scene()]),
          ),
        ),
    });
    const result = await buildScriptablePack({
      definition,
      sourcePath: 'assets/param.pack.ts',
      values: { count: 2 },
      outputs: producers(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.product.assets.map((asset) => asset.guid)).toEqual([
      AssetGuid.format(AssetGuid.derive(packageId, 'scene/0')),
      AssetGuid.format(AssetGuid.derive(packageId, 'scene/1')),
    ]);
    expect(result.value.stagedOutputs.map((output) => output.sourceKey)).toEqual([
      'scene/0',
      'scene/1',
    ]);
  });

  it('retries forward content reads until the internal worklist makes progress', async () => {
    const firstId = id('01900000-0000-7000-8000-000000000050');
    const secondId = id('01900000-0000-7000-8000-000000000051');
    const first = definePack({
      schemaVersion: '2.0.0',
      packageId: firstId,
      build: () => ok({ 'scene/first': scene() }),
    });
    const dependencyGuid = AssetGuid.derive(firstId, 'scene/first');
    const second = definePack({
      schemaVersion: '2.0.0',
      packageId: secondId,
      build: async ({ readByGuid }) => {
        const dependency = await readByGuid(dependencyGuid);
        if (!dependency.ok) return err(dependency.error);
        return ok({ 'scene/second': scene() });
      },
    });
    const result = await buildScriptablePackWorklist({
      subjects: [
        // Keep the dependency consumer first even after the worklist applies
        // its stable source-path ordering, so this proves a real retry pass.
        { definition: second, sourcePath: 'assets/a-second.pack.ts' },
        { definition: first, sourcePath: 'assets/z-first.pack.ts' },
      ],
      outputs: producers(),
    });
    expect(result).toMatchObject({ ok: true, value: { iterations: 2 } });
    if (result.ok) expect(result.value.products).toHaveLength(2);
  });

  it('returns a structured stall when no subject can satisfy a content read', async () => {
    const missing = AssetGuid.derive(id('01900000-0000-7000-8000-000000000060'), 'scene/missing');
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: id('01900000-0000-7000-8000-000000000061'),
      build: async ({ readByGuid }) => {
        const dependency = await readByGuid(missing);
        if (!dependency.ok) return err(dependency.error);
        return ok({ 'scene/main': scene() });
      },
    });
    const result = await buildScriptablePackWorklist({
      subjects: [{ definition, sourcePath: 'assets/missing.pack.ts' }],
      outputs: producers(),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'pack-content-dependency-stalled' } });
  });

  it('uses the published asset source when a dynamic build reads a non-staged dependency', async () => {
    const packageId = id('01900000-0000-7000-8000-000000000062');
    const dependencyPackageId = id('01900000-0000-7000-8000-000000000063');
    const dependencyGuid = AssetGuid.derive(dependencyPackageId, 'sampler/main');
    const dependency = {
      kind: 'sampler' as const,
      magFilter: 'linear' as const,
      minFilter: 'linear' as const,
      mipmapFilter: 'linear' as const,
      addressModeU: 'repeat' as const,
      addressModeV: 'repeat' as const,
      addressModeW: 'repeat' as const,
    };
    const assetSource: ScriptablePackAssetSnapshotSource = {
      async readByGuid(guid) {
        return AssetGuid.equals(guid, dependencyGuid)
          ? ok({ asset: dependency, generation: 7, digest: 'sha256:published' })
          : err({
              code: 'asset-not-found',
              expected: 'the published dependency',
              hint: 'publish the dependency before rebuilding',
            });
      },
    };
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: async ({ readByGuid }) => {
        const read = await readByGuid(dependencyGuid);
        if (!read.ok) return err(read.error);
        return ok({ 'scene/main': scene() });
      },
    });
    const result = await produceScriptablePackProducts({
      sources: [
        {
          sourcePath: 'assets/consumer.pack.ts',
          displaySourcePath: 'assets/consumer.pack.ts',
          definition,
          sourceClosure: [],
          publicationGeneration: 1,
          policy: {
            base: '/',
            packagePath: 'assets/consumer.pack.json',
            artifactPath: (guid, key) => `artifacts/${guid}/${key}`,
          },
        },
      ],
      assetSource,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.get('assets/consumer.pack.ts')?.product.externalEvidence).toEqual([
      {
        guid: AssetGuid.format(dependencyGuid),
        usage: 'content',
        generation: 7,
        digest: 'sha256:published',
      },
    ]);
    const revision = result.value.get('assets/consumer.pack.ts')?.revision;
    expect(revision?.observedAt).toBe(0);
  });

  it('does not replace a staged read failure with a published value', async () => {
    const packageId = id('01900000-0000-7000-8000-000000000064');
    const dependencyGuid = AssetGuid.derive(packageId, 'scene/dependency');
    const assetSource: ScriptablePackAssetSnapshotSource = {
      async readByGuid() {
        return err({
          code: 'asset-fetch-failed',
          expected: 'the staged dependency read to succeed',
          hint: 'repair the staged generation before retrying',
        });
      },
    };
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: async ({ readByGuid }) => {
        const read = await readByGuid(dependencyGuid);
        if (!read.ok) return err(read.error);
        return ok({ 'scene/main': scene() });
      },
    });
    const result = await produceScriptablePackProducts({
      sources: [
        {
          sourcePath: 'assets/failing-consumer.pack.ts',
          displaySourcePath: 'assets/failing-consumer.pack.ts',
          definition,
          sourceClosure: [],
          publicationGeneration: 1,
          policy: {
            base: '/',
            packagePath: 'assets/failing-consumer.pack.json',
            artifactPath: (guid, key) => `artifacts/${guid}/${key}`,
          },
        },
      ],
      assetSource,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-fetch-failed' } });
  });

  it('converts a throwing output producer into a structured import failure', async () => {
    const outputs = new AssetOutputProducerRegistry();
    outputs.register({
      kind: 'scene',
      version: 'test',
      produce: () => {
        throw new Error('producer exploded');
      },
    });
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000065'),
        build: () => ok({ 'scene/main': scene() }),
      }),
      sourcePath: 'assets/throwing-producer.pack.ts',
      outputs,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'import-internal-error' } });
  });

  it('rejects malformed output producer products at the import boundary', async () => {
    const outputs = new AssetOutputProducerRegistry();
    outputs.register({
      kind: 'scene',
      version: 'test',
      produce: () => ({ ok: true, value: null }) as never,
    });
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000066'),
        build: () => ok({ 'scene/main': scene() }),
      }),
      sourcePath: 'assets/malformed-producer.pack.ts',
      outputs,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
  });

  it('converts a malformed Pack build result into a structured import failure', async () => {
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000067'),
        build: () => null as never,
      }),
      sourcePath: 'assets/malformed-build.pack.ts',
      outputs: producers(),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'import-internal-error' } });
  });
});
