import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  type MaterialCookProgramContext,
} from '@forgeax/engine-pack/material-cook';
import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { createMaterialLoader, type MaterialPublication } from '../material/loader.js';
import {
  installMaterialReadyShaders,
  projectMaterialRecord,
  selectMaterialPassProgram,
} from '../material/runtime-shader.js';

const context: MaterialCookProgramContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};
function fixture() {
  const passes = ['Forward', 'Overlay'].map((name) => ({ name, program: { module: name } }));
  const programs = passes.map(({ name }) => {
    const bytes = new TextEncoder().encode(`program ${name}`);
    return {
      specializationKey: name,
      artifact: {
        mediaType: 'text/wgsl',
        path: `${name}.wgsl`,
        digest: createMaterialArtifactDigest(bytes),
        bytes,
      },
      selections: [{ pass: name, context }],
    };
  });
  const artifactDigest = createMaterialProgramSetDigest(programs, passes);
  const record: CookedMaterialRecord = {
    schemaVersion: 'material-cook/4',
    guid: 'material',
    materialGuid: 'material',
    publicationGeneration: 1,
    specializationKey: 'publication',
    artifactDigest,
    sourceClosure: ['material.json'],
    parameterContract: { parameters: [], values: {} },
    resolved: { passes, parameters: [], values: {} },
    refs: { parent: [], textures: [], samplers: [], modules: [] },
    programs,
    receipt: {
      schemaVersion: 'material-cook/4',
      sourceClosure: ['material.json'],
      profile: 'webgpu/v1',
      compilerVersion: 'test',
      identity: {
        materialContractDigest: 'contract',
        sourceRevision: 'source',
        sourceClosureDigest: 'closure',
        layoutIdentity: 'layout',
        programIdentity: 'program',
        pipelineIdentity: 'pipeline',
        materialPublicationIdentity: 'publication',
        cookIdentity: 'cook',
        compilerFingerprint: 'compiler',
        wasm: { sourceContentKey: 'source', artifactSha256: 'artifact', glueSha256: 'glue' },
        artifactDigest,
        valueGeneration: 1,
        dependencyGeneration: 1,
        cookGeneration: 1,
      },
      derivedInterface: { layoutIdentity: 'layout' },
    },
  };
  const artifacts = Object.fromEntries(
    programs.map(({ artifact }) => [
      artifact.path,
      { bytes: new Uint8Array(artifact.bytes), digest: artifact.digest },
    ]),
  );
  const publication: MaterialPublication = { guid: 'material', record, artifacts };
  return { record, artifacts, publication };
}
const request = { guid: 'material', specializationKey: 'publication' };
const load = (publication: MaterialPublication) =>
  createMaterialLoader({ loadPublication: async () => publication }).load(request);

it('publishes Ready only after every program has verified immutable bytes', async () => {
  const { publication, artifacts } = fixture();
  const result = await load(publication);
  expect(result.status).toBe('Ready');
  if (result.status !== 'Ready') throw new Error('Expected Ready');
  expect(result.programs).toHaveLength(2);
  const before = result.programs[1]?.artifact.bytes.slice();
  artifacts['Overlay.wgsl']?.bytes.fill(0);
  expect(result.programs[1]?.artifact.bytes).toEqual(before);
  expect(result.record.programs).toBe(result.programs);
});

it('rejects a missing or corrupted second program instead of publishing a partial generation', async () => {
  const { publication, artifacts } = fixture();
  delete artifacts['Overlay.wgsl'];
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: { code: 'asset-artifact-missing', detail: { field: 'Overlay.wgsl' } },
  });
  artifacts['Overlay.wgsl'] = { bytes: new TextEncoder().encode('old generation'), digest: 'old' };
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: { code: 'asset-artifact-integrity-mismatch', detail: { field: 'Overlay.wgsl' } },
  });
});

it('rejects a stale selection manifest before publishing Ready', async () => {
  const { publication, record } = fixture();
  expect(
    await load({
      ...publication,
      record: {
        ...record,
        resolved: {
          ...record.resolved,
          passes: record.resolved.passes.map((pass) => ({
            ...pass,
            program: { ...pass.program, fragmentEntry: 'changed' },
          })),
        },
      },
    }),
  ).toMatchObject({ status: 'Error', error: { code: 'material-cook-record-invalid' } });
});

it('installs programs under their own keys and preserves each Pass selection', async () => {
  const { publication } = fixture();
  const ready = await load(publication);
  if (ready.status !== 'Ready') throw new Error('Expected Ready');
  const shaders = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Program installation must not compile GPU modules');
      },
    } as never,
    manifestUrl: undefined,
  });
  const artifacts = new MaterialArtifactRegistry();
  const projection = installMaterialReadyShaders(shaders, ready, artifacts);
  expect(
    projection.passes.map((pass) => pass.programs.map((program) => program.specializationKey)),
  ).toEqual([['Forward'], ['Overlay']]);
  expect(shaders.findMaterialArtifact('Forward').ok).toBe(true);
  expect(shaders.findMaterialArtifact('Overlay').ok).toBe(true);
  expect(shaders.findMaterialArtifact('publication').ok).toBe(false);
});

it('leaves both registries unchanged when a later program conflicts', async () => {
  const { publication } = fixture();
  const ready = await load(publication);
  if (ready.status !== 'Ready') throw new Error('Expected Ready');
  const shaders = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Program installation must not compile GPU modules');
      },
    } as never,
    manifestUrl: undefined,
  });
  const artifacts = new MaterialArtifactRegistry();
  artifacts
    .register({
      key: 'Overlay',
      bytes: new TextEncoder().encode('conflicting prior program'),
      metadata: { paramSchema: [] },
    })
    .unwrap();
  expect(() => installMaterialReadyShaders(shaders, ready, artifacts)).toThrow(
    'material-artifact-conflict',
  );
  expect(artifacts.get('Forward')).toBeUndefined();
  expect(shaders.findMaterialArtifact('Forward').ok).toBe(false);
  expect(shaders.findMaterialArtifact('Overlay').ok).toBe(false);
});

it('selects the exact Pass and context and refuses unsupported or ambiguous selections', () => {
  const { record } = fixture();
  const projection = projectMaterialRecord(record);
  expect(selectMaterialPassProgram(projection, 'Overlay', context).specializationKey).toBe(
    'Overlay',
  );
  expect(() =>
    selectMaterialPassProgram(projection, 'Overlay', { ...context, geometry: 'skinned' }),
  ).toThrow('no unique published program');
  expect(() => selectMaterialPassProgram(projection, 'Missing', context)).toThrow(
    'no unique published program',
  );
  expect(() =>
    selectMaterialPassProgram(
      { ...projection, passes: [...projection.passes, ...projection.passes] },
      'Forward',
      context,
    ),
  ).toThrow('no unique published program');
});
