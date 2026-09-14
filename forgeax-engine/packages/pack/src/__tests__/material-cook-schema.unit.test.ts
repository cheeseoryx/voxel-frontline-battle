import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  type MaterialCookProgram,
  projectCookedMaterialRecord,
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
} from '../evidence/material-cook.js';

const record: CookedMaterialRecord = {
  schemaVersion: 'material-cook/4',
  guid: 'mat-root',
  authored: {
    kind: 'material',
    passes: [{ name: 'forward', program: { module: 'core/pbr' } }],
    parameters: [{ name: 'roughness', type: 'f32' }],
    values: { roughness: 0.5 },
  },
  resolved: {
    passes: [{ name: 'forward', program: { module: 'core/pbr' } }],
    parameters: [{ name: 'roughness', type: 'f32' }],
    values: { roughness: 0.5 },
  },
  refs: { parent: [], textures: [], samplers: [], modules: ['core/pbr'] },
  programs: [
    {
      specializationKey: 'sha256:program',
      selections: [
        {
          pass: 'forward',
          context: {
            backend: 'webgpu',
            capability: 'storage-buffer',
            pipeline: 'forward',
            geometry: 'mesh',
            pass: 'forward',
            profile: 'forgeax-material-wgsl-v1',
            toolchain: 'naga-oil',
            instrumentation: 'none',
          },
        },
      ],
      artifact: {
        mediaType: 'text/wgsl',
        path: 'materials/mat-root/forward.wgsl',
        digest: 'sha256:artifact',
        bytes: new TextEncoder().encode('shader'),
      },
    },
  ],
  receipt: {
    schemaVersion: 'material-cook/4',
    sourceClosure: ['materials/mat-root.material.json'],
    profile: 'webgpu/v1',
    compilerVersion: 'compiler/1',
    identity: {
      materialContractDigest: 'sha256:material-contract',
      sourceRevision: 'sha256:source-revision',
      sourceClosureDigest: 'sha256:source-closure',
      layoutIdentity: 'sha256:layout',
      programIdentity: 'sha256:program',
      pipelineIdentity: 'sha256:pipeline',
      materialPublicationIdentity: 'sha256:publication',
      cookIdentity: 'sha256:input',
      compilerFingerprint: 'sha256:compiler',
      wasm: {
        sourceContentKey: 'sha256:wasm-source',
        artifactSha256: 'sha256:wasm-artifact',
        glueSha256: 'sha256:wasm-glue',
      },
      artifactDigest: 'sha256:artifact',
      valueGeneration: 1,
      dependencyGeneration: 1,
      cookGeneration: 1,
    },
    derivedInterface: { layoutIdentity: 'sha256:layout' },
  },
};

function seal(value: CookedMaterialRecord): CookedMaterialRecord {
  return {
    ...value,
    receipt: {
      ...value.receipt,
      identity: {
        ...value.receipt.identity,
        artifactDigest: createMaterialProgramSetDigest(value.programs, value.resolved.passes),
      },
    },
  };
}

describe('cooked material schema', () => {
  it('requires material-cook/4 identity and derived interface association', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../schema/material-cook.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      properties: Record<
        string,
        { const?: string; required?: string[]; properties?: Record<string, unknown> }
      >;
      required: string[];
    };
    expect(schema.properties.schemaVersion?.const).toBe('material-cook/4');
    expect(schema.properties.receipt?.required).toEqual(
      expect.arrayContaining(['identity', 'derivedInterface']),
    );
    expect(schema.properties.receipt?.properties?.derivedInterface).toBeDefined();
  });

  it('defines the v4 identity, provenance, and generation contract', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../schema/material-cook.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      properties: Record<
        string,
        { const?: string; required?: string[]; properties?: Record<string, unknown> }
      >;
    };
    expect(schema.properties.schemaVersion?.const).toBe('material-cook/4');
    expect(schema.properties.receipt?.properties?.identity).toMatchObject({
      type: 'object',
      required: expect.arrayContaining([
        'materialContractDigest',
        'sourceRevision',
        'sourceClosureDigest',
        'layoutIdentity',
        'programIdentity',
        'pipelineIdentity',
        'materialPublicationIdentity',
        'cookIdentity',
        'compilerFingerprint',
        'wasm',
        'artifactDigest',
        'valueGeneration',
        'dependencyGeneration',
        'cookGeneration',
      ]),
    });
    expect(schema.properties.receipt?.required).toEqual(
      expect.arrayContaining(['identity', 'derivedInterface']),
    );
  });

  it('serializes a stable cooked DTO and derives an artifact digest', () => {
    const first = serializeCookedMaterialRecord(seal(record));
    const second = serializeCookedMaterialRecord(seal({ ...record }));

    expect(first).toBe(second);
    expect(createMaterialArtifactDigest(new TextEncoder().encode('shader'))).toBe(
      'sha256:e137e75a5e0e7a623ca39de480667a55b43e0eedec58767634ebaef07c33383a',
    );
    expect(validateCookedMaterialRecord(JSON.parse(first))).toEqual({
      ok: true,
      value: seal(record),
    });
  });

  it('projects cooked data without exposing an authored GUID entry', () => {
    const projection = projectCookedMaterialRecord(record);

    expect(projection.resolved.values).toEqual({ roughness: 0.5 });
    expect(projection.programs[0]?.artifact.digest).toBe('sha256:artifact');
    expect(projection).not.toHaveProperty('guid');
    expect(projection).not.toHaveProperty('authored');
  });

  it('admits different programs with equal entry names and shared programs with multiple selections', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    const passes = [
      ...record.resolved.passes,
      {
        name: 'second',
        program: { module: 'other', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
      },
    ];
    const selection = {
      ...primary.selections[0],
      pass: 'second',
    } as MaterialCookProgram['selections'][number];
    const distinct = seal({
      ...record,
      resolved: { ...record.resolved, passes },
      programs: [
        primary,
        {
          ...primary,
          specializationKey: 'second',
          artifact: {
            ...primary.artifact,
            path: 'second.wgsl',
            digest: 'sha256:second',
            bytes: new TextEncoder().encode('other'),
          },
          selections: [selection],
        },
      ],
    });
    expect(validateCookedMaterialRecord(distinct)).toMatchObject({ ok: true });
    const shared = seal({
      ...distinct,
      programs: [{ ...primary, selections: [...primary.selections, selection] }],
    });
    expect(validateCookedMaterialRecord(shared)).toMatchObject({ ok: true });
  });

  it('rejects ambiguous selections, unpublished passes and unknown context axes', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    expect(
      validateCookedMaterialRecord({
        ...record,
        programs: [primary, { ...primary, specializationKey: 'duplicate' }],
      }),
    ).toMatchObject({
      ok: false,
      error: { detail: { actual: 'ambiguous Pass/context selection' } },
    });
    expect(
      validateCookedMaterialRecord({
        ...record,
        resolved: {
          ...record.resolved,
          passes: [...record.resolved.passes, { name: 'missing', program: { module: 'other' } }],
        },
      }),
    ).toMatchObject({ ok: false, error: { detail: { actual: 'unpublished Pass' } } });
    expect(
      validateCookedMaterialRecord({
        ...record,
        programs: [
          {
            ...primary,
            selections: [
              { pass: 'forward', context: { ...primary.selections[0]?.context, arbitrary: true } },
            ],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: { detail: { field: 'programs[0].selections[0].context.arbitrary' } },
    });
  });

  it('rejects stale manifests after entry or context changes and rejects legacy publication fields', () => {
    const sealed = seal(record);
    expect(
      validateCookedMaterialRecord({
        ...sealed,
        resolved: {
          ...sealed.resolved,
          passes: [{ name: 'forward', program: { module: 'core/pbr', fragmentEntry: 'fs_other' } }],
        },
      }),
    ).toMatchObject({ ok: false, error: { detail: { field: 'receipt.identity.artifactDigest' } } });
    const primary = record.programs[0] as MaterialCookProgram;
    expect(
      validateCookedMaterialRecord({
        ...sealed,
        programs: [
          {
            ...primary,
            selections: [
              {
                pass: 'forward',
                context: { ...primary.selections[0]?.context, geometry: 'skinned' },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { detail: { field: 'receipt.identity.artifactDigest' } } });
    expect(
      validateCookedMaterialRecord({ ...sealed, schemaVersion: 'material-cook/3' }),
    ).toMatchObject({ ok: false });
    expect(validateCookedMaterialRecord({ ...sealed, artifact: primary.artifact })).toMatchObject({
      ok: false,
    });
  });

  it('rejects missing fields and unsupported schema versions', () => {
    expect(validateCookedMaterialRecord({ ...record, refs: undefined })).toMatchObject({
      ok: false,
      error: { code: 'material-cook-record-invalid' },
    });
    expect(
      validateCookedMaterialRecord({ ...record, schemaVersion: 'material-cook/1' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'material-cook-record-invalid' },
    });
  });

  it('rejects a Standard record whose receipt layer plan is stale', () => {
    const standardPass = { name: 'forward', program: { module: 'forgeax::default-standard-pbr' } };
    const standardPlan = deriveStandardLayerPlan(record.resolved.parameters, [standardPass]);
    const standardRecord = seal({
      ...record,
      resolved: { ...record.resolved, passes: [standardPass] },
      receipt: {
        ...record.receipt,
        derivedInterface: {
          layoutIdentity: 'sha256:layout',
          layerPlanIdentity: standardPlan.identity,
        },
      },
    });
    expect(validateCookedMaterialRecord(standardRecord)).toMatchObject({ ok: true });
    expect(
      validateCookedMaterialRecord({
        ...standardRecord,
        receipt: {
          ...standardRecord.receipt,
          derivedInterface: { layoutIdentity: 'sha256:layout', layerPlanIdentity: 'stale' },
        },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        detail: { field: 'receipt.derivedInterface.layerPlanIdentity' },
      },
    });
  });

  it('rejects a Standard record whose receipt omits the layer plan identity', () => {
    const standardPass = { name: 'forward', program: { module: 'forgeax::default-standard-pbr' } };
    const standardPlan = deriveStandardLayerPlan(record.resolved.parameters, [standardPass]);
    const standardRecord = seal({
      ...record,
      resolved: { ...record.resolved, passes: [standardPass] },
      receipt: {
        ...record.receipt,
        derivedInterface: {
          layoutIdentity: 'sha256:layout',
          layerPlanIdentity: standardPlan.identity,
        },
      },
    });
    expect(
      validateCookedMaterialRecord({
        ...standardRecord,
        receipt: {
          ...standardRecord.receipt,
          derivedInterface: { layoutIdentity: 'sha256:layout' },
        },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        detail: { field: 'receipt.derivedInterface.layerPlanIdentity' },
      },
    });
  });
});
