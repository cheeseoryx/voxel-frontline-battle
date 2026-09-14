import type { CookedMaterialRecord, MaterialCookProgramContext } from '@forgeax/engine-pack';
import { materialProgramContextKey } from '@forgeax/engine-pack/material-cook';
import {
  type MaterialArtifactConflictError,
  MaterialArtifactRegistry,
  type MaterialRuntimeArtifact,
  type ShaderRegistry,
} from '@forgeax/engine-shader';
import type { MaterialParameter, MaterialValue, ParamSchemaEntry } from '@forgeax/engine-types';
import type { MaterialLoadError, MaterialReady } from './loader';

export interface MaterialRenderPassProjection {
  readonly name: string;
  readonly module: string;
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
  readonly moduleSlots?: Readonly<Record<string, string>>;
  readonly renderState?: Readonly<Record<string, unknown>>;
  readonly programs: readonly {
    readonly context: MaterialCookProgramContext;
    readonly specializationKey: string;
    readonly artifactHash: string;
  }[];
}

export interface MaterialRenderProjection {
  readonly materialGuid: string;
  readonly publicationGeneration: number;
  readonly specializationKey: string;
  readonly artifactHash: string;
  readonly passes: readonly MaterialRenderPassProjection[];
  readonly runtimeValues: Readonly<Record<string, MaterialValue | null>>;
  readonly staticSelection: readonly string[];
}

/** Exact Pass/context lookup; the renderer supplies all domain-owned axes. */
export function selectMaterialPassProgram(
  projection: MaterialRenderProjection,
  passName: string,
  context: MaterialCookProgramContext,
): MaterialRenderPassProjection['programs'][number] {
  const key = materialProgramContextKey(context);
  const matches = projection.passes
    .filter((pass) => pass.name === passName)
    .flatMap((pass) =>
      pass.programs.filter((program) => materialProgramContextKey(program.context) === key),
    );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw Object.assign(
      new Error(
        `Material ${projection.materialGuid} has no unique published program for ${passName} in ${key}`,
      ),
      {
        code: 'material-specialization-not-cooked',
        expected: 'exactly one program for the selected Pass and renderer context',
        hint: 'cook the required context before rendering this material',
        retryable: false,
        recoveryActions: ['recook-material-publication'],
        detail: {
          guid: projection.materialGuid,
          specializationKey: projection.specializationKey,
          pass: passName,
          context,
          matches: matches.length,
        },
      } satisfies MaterialLoadError['error'],
    );
  }
  return matches[0];
}

/** Project authored MaterialAsset parameters into the runtime shader schema. */
export function materialParametersToParamSchema(
  parameters: readonly MaterialParameter[],
): readonly ParamSchemaEntry[] {
  return parameters.flatMap((parameter): ParamSchemaEntry[] => {
    if (parameter.type === 'bool') return [];
    if (parameter.type === 'texture' || parameter.type === 'texture_cube') {
      return [
        {
          name: parameter.name,
          type: parameter.type === 'texture_cube' ? 'texture_cube' : 'texture2d',
        },
      ];
    }
    const defaultValue = parameter.default;
    const numericDefault =
      typeof defaultValue === 'number' ||
      (Array.isArray(defaultValue) && defaultValue.every((item) => typeof item === 'number'))
        ? { default: defaultValue }
        : {};
    return [
      {
        name: parameter.name,
        type: parameter.type,
        ...(parameter.colorSpace === undefined ? {} : { colorSpace: parameter.colorSpace }),
        ...numericDefault,
      },
    ];
  });
}

/** Project authored pass module ids onto the renderer's canonical ids. */
export function runtimeMaterialShaderId(
  module: string | undefined,
  passName?: string,
): string | undefined {
  if (
    passName === 'shadow-caster' &&
    (module === 'forgeax_material::standard' ||
      module === 'forgeax_material::unlit' ||
      module === 'forgeax::default-standard-pbr' ||
      module === 'forgeax::default-unlit')
  ) {
    return 'forgeax::default-shadow-caster';
  }
  switch (module) {
    case 'forgeax_material::standard':
      return 'forgeax::default-standard-pbr';
    case 'forgeax_material::unlit':
      return 'forgeax::default-unlit';
    case 'forgeax_material::sprite':
      return 'forgeax::sprite';
    case 'forgeax_material::sprite-lit':
      return 'forgeax::sprite-lit';
    default:
      return module;
  }
}

export function projectMaterialRecord(record: CookedMaterialRecord): MaterialRenderProjection {
  return {
    materialGuid: record.materialGuid ?? record.guid,
    publicationGeneration: record.publicationGeneration ?? record.receipt.identity.cookGeneration,
    specializationKey: record.specializationKey ?? record.receipt.identity.artifactDigest,
    artifactHash: record.receipt.identity.artifactDigest,
    passes: record.resolved.passes.map((pass) => ({
      name: pass.name,
      module: pass.program.module,
      ...(pass.program.vertexEntry === undefined ? {} : { vertexEntry: pass.program.vertexEntry }),
      ...(pass.program.fragmentEntry === undefined
        ? {}
        : { fragmentEntry: pass.program.fragmentEntry }),
      ...(pass.program.moduleSlots === undefined ? {} : { moduleSlots: pass.program.moduleSlots }),
      ...(pass.renderState === undefined ? {} : { renderState: pass.renderState }),
      programs: record.programs.flatMap((program) =>
        program.selections
          .filter((selection) => selection.pass === pass.name)
          .map((selection) => ({
            context: selection.context,
            specializationKey: program.specializationKey,
            artifactHash: program.artifact.digest,
          })),
      ),
    })),
    runtimeValues: record.resolved.values,
    staticSelection: [],
  };
}

function conflictError(error: MaterialArtifactConflictError): Error {
  return Object.assign(new Error(`${error.code}: ${error.detail.key}`), error);
}

/** Preflight the complete set before mutating either runtime registry. */
export function installMaterialReadyShaders(
  shaderRegistry: ShaderRegistry,
  readiness: MaterialReady,
  artifactRegistry: MaterialArtifactRegistry,
): MaterialRenderProjection {
  // Defaults belong to the root value contract, not an immutable shared program.
  const paramSchema = materialParametersToParamSchema(readiness.parameterContract.parameters).map(
    ({ default: _default, ...parameter }) => parameter,
  );
  const entries = readiness.programs.map((program) => {
    const source = new TextDecoder().decode(program.artifact.bytes);
    if (source.length === 0)
      throw new Error(
        `MaterialReady ${readiness.guid} contains an empty shader program ${program.specializationKey}`,
      );
    const pass = readiness.record.resolved.passes.find((pass) =>
      program.selections.some((selection) => selection.pass === pass.name),
    );
    const artifact: MaterialRuntimeArtifact = {
      key: program.specializationKey,
      bytes: new Uint8Array(program.artifact.bytes),
      digest: program.artifact.digest,
      metadata: Object.freeze({ module: pass?.program.module, paramSchema }),
    };
    return { artifact, source };
  });
  const validation = new MaterialArtifactRegistry();
  for (const { artifact, source } of entries) {
    const previous = artifactRegistry.get(artifact.key);
    if (previous !== undefined) validation.register(previous).unwrap();
    const checked = validation.register(artifact);
    if (!checked.ok) throw conflictError(checked.error);
    const shader = shaderRegistry.findMaterialArtifact(artifact.key);
    if (
      shader.ok &&
      (shader.value.source !== source ||
        JSON.stringify(shader.value.paramSchema) !== JSON.stringify(paramSchema))
    ) {
      throw conflictError({
        code: 'material-artifact-conflict',
        expected: 'one immutable source and interface per program key',
        hint: 're-cook the conflicting program',
        detail: {
          key: artifact.key,
          dimension: shader.value.source === source ? 'param-schema' : 'bytes',
        },
      });
    }
  }
  for (const { artifact, source } of entries) {
    artifactRegistry.register(artifact).unwrap();
    if (!shaderRegistry.findMaterialArtifact(artifact.key).ok)
      shaderRegistry.installMaterialArtifact(artifact.key, { source, paramSchema });
  }
  return projectMaterialRecord(readiness.record);
}
