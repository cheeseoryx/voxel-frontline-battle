import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcEntryStore } from '@forgeax/engine-ddc';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitImportPublication,
  discardImportPublication,
  type ImportPublicationInput,
  stageImportPublication,
} from '../source-package-publication.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY = 'a'.repeat(64);
const ARTIFACT_PATH = `${GUID}/body.bin`;
const ARTIFACT_BYTES = new Uint8Array([9, 8, 7]);
const ARTIFACT_DIGEST = `sha256:${createHash('sha256').update(ARTIFACT_BYTES).digest('hex')}`;

const validArtifact = {
  path: ARTIFACT_PATH,
  mediaType: 'application/octet-stream',
  bytes: ARTIFACT_BYTES,
};

const validDescriptor = {
  path: ARTIFACT_PATH,
  mediaType: validArtifact.mediaType,
  byteLength: ARTIFACT_BYTES.byteLength,
  integrity: { algorithm: 'sha256' as const, digest: ARTIFACT_DIGEST },
};

function closurePack(
  artifacts: Readonly<Record<string, unknown>> = { body: validDescriptor },
): Record<string, unknown> {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: GUID,
        kind: 'fixture',
        payload: { value: 'same' },
        refs: [],
        artifacts,
      },
    ],
  };
}

function input(root: string, desiredKey = KEY): ImportPublicationInput {
  return {
    root,
    guid: GUID,
    desiredKey,
    pack: {
      schemaVersion: '2.0.0',
      assets: [{ guid: GUID, kind: 'fixture', payload: { value: 'same' }, refs: [] }],
    },
    previousCatalog: [],
    nextCatalog: [],
    publishedGuids: [GUID],
  };
}

describe('source package publication concurrency', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('waits for an equivalent newer owner after a strict stale commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const publicationInput = input(root);
    const first = await stageImportPublication(publicationInput);
    const second = await stageImportPublication(publicationInput);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const winner = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return commitImportPublication(second.candidate);
    })();
    const loser = await commitImportPublication(first.candidate);
    const winnerResult = await winner;

    expect(loser).toMatchObject({ ok: true, head: { state: 'current', currentKey: KEY } });
    expect(winnerResult).toMatchObject({ ok: true, head: { state: 'current', currentKey: KEY } });
  });

  it('keeps a stale publication with a different desired key fail-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const first = await stageImportPublication(input(root, 'a'.repeat(64)));
    const second = await stageImportPublication(input(root, 'b'.repeat(64)));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const result = await commitImportPublication(first.candidate);
    await discardImportPublication(second.candidate);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'source-package-ddc-failed', detail: 'DDC lifecycle commit returned stale' },
    });
  });

  it('persists concurrent equivalent transports without sharing a temporary path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const transport = {
      path: join(root, 'runtime', `${GUID}.pack.json`),
      body: JSON.stringify({ guid: GUID, value: 'concurrent' }),
    };
    const staged = await Promise.all(
      Array.from({ length: 8 }, () => stageImportPublication({ ...input(root), transport })),
    );
    expect(staged.every((candidate) => candidate.ok)).toBe(true);
    if (staged.some((candidate) => !candidate.ok)) return;

    const results = await Promise.all(
      staged.map((candidate) =>
        candidate.ok ? commitImportPublication(candidate.candidate) : Promise.resolve(candidate),
      ),
    );
    expect(results.every((result) => result.ok && result.transportPersisted)).toBe(true);
    expect(await readFile(transport.path, 'utf8')).toBe(transport.body);
    expect((await readdir(join(root, 'runtime'))).some((name) => name.includes('.tmp'))).toBe(
      false,
    );
  });

  it('publishes the complete transport artifact closure into the DDC entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const pack = closurePack();
    const publicationInput = {
      ...input(root),
      pack,
      transport: {
        path: join(root, 'runtime', `${GUID}.pack.json`),
        body: JSON.stringify(pack),
        artifacts: [validArtifact],
      },
    };

    const staged = await stageImportPublication(publicationInput);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    await expect(commitImportPublication(staged.candidate)).resolves.toMatchObject({ ok: true });

    const entry = await new DdcEntryStore(root).read(KEY);
    expect(entry?.artifacts[ARTIFACT_PATH]).toMatchObject({
      mediaType: validArtifact.mediaType,
      bytes: validArtifact.bytes,
    });
  });

  it.each([
    {
      label: 'missing body',
      pack: closurePack(),
      artifacts: [],
    },
    {
      label: 'media type mismatch',
      pack: closurePack(),
      artifacts: [{ ...validArtifact, mediaType: 'application/x-wrong' }],
    },
    {
      label: 'byte length mismatch',
      pack: closurePack(),
      artifacts: [{ ...validArtifact, bytes: new Uint8Array([9, 8]) }],
    },
    {
      label: 'sha256 mismatch',
      pack: closurePack({
        body: {
          ...validDescriptor,
          integrity: { algorithm: 'sha256' as const, digest: 'sha256:bad' },
        },
      }),
      artifacts: [validArtifact],
    },
    {
      label: 'duplicate transport path',
      pack: closurePack(),
      artifacts: [validArtifact, validArtifact],
    },
    {
      label: 'duplicate descriptor path',
      pack: closurePack({ body: validDescriptor, alias: { ...validDescriptor } }),
      artifacts: [validArtifact],
    },
    {
      label: 'unexpected transport body',
      pack: closurePack(),
      artifacts: [
        validArtifact,
        {
          path: `${GUID}/extra.bin`,
          mediaType: 'application/octet-stream',
          bytes: new Uint8Array([1]),
        },
      ],
    },
    {
      label: 'transport body mismatch',
      pack: closurePack(),
      body: JSON.stringify({ schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] }),
      artifacts: [validArtifact],
    },
  ] as const)('rejects $label before advancing the DDC head', async ({ pack, artifacts, body }) => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-publication-'));
    roots.push(root);
    const publicationInput: ImportPublicationInput = {
      ...input(root),
      pack,
      transport: {
        path: join(root, 'runtime', `${GUID}.pack.json`),
        body: body ?? JSON.stringify(pack),
        artifacts,
      },
    };

    const staged = await stageImportPublication(publicationInput);

    expect(staged).toMatchObject({
      ok: false,
      error: {
        code: 'source-package-publication-invalid',
      },
      head: { state: 'missing' },
    });
    expect(await new DdcEntryStore(root).listKeys()).toEqual([]);
  });
});
