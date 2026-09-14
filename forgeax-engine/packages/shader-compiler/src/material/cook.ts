import { isStandardRootModule } from '@forgeax/engine-pack';
import type {
  MaterialParameter,
  ParamSchemaEntry,
  ResolvedMaterial,
  Result,
  StandardLayerPlan,
} from '@forgeax/engine-types';
import {
  createMaterialError,
  type DerivedMaterialInterface,
  derive,
  err,
  type MaterialError,
  type MaterialParameterProjection,
  ok,
  standardPhysicalTextureFields,
} from '@forgeax/engine-types';
import { compareMaterialBindings } from '../compare-param-schema.js';
import { ShaderError } from '../errors.js';
import { type CompileResult, compileShader } from '../index.js';
import { compareDerivedMaterialInterface } from '../reflection.js';
import { composeSurfaceSource, digestMaterialSourceClosure } from './compose.js';
import { lowerStandardContract, lowerStandardPhysicalBindings } from './lower-standard-contract.js';
import { type MaterialTable, resolveMaterialAsset } from './resolve.js';
import type { MaterialSourceCatalog } from './source-catalog.js';
import {
  DEFAULT_MATERIAL_VARIANT_CONTEXT,
  lowerMaterialVariantContext,
  type MaterialVariantContext,
} from './variant-context.js';

export interface MaterialCookRequest {
  readonly material: string;
  readonly table: MaterialTable;
  readonly sources: MaterialSourceCatalog;
  readonly context?: MaterialVariantContext;
}

export interface MaterialCookedPass {
  readonly pass: string;
  readonly module: string;
  readonly context: MaterialVariantContext;
  readonly parameters: readonly MaterialParameter[];
  readonly paramSchema: readonly ParamSchemaEntry[];
  readonly generatedModule: string;
  readonly sourceClosure: readonly string[];
  /** Digest of the exact template/Surface/ABI/parameter/transitive closure. */
  readonly sourceClosureDigest: string;
  readonly compile: CompileResult;
  readonly layoutIdentity: string;
}

export type GeneratedMaterialParameterProjection = MaterialParameterProjection;

export interface MaterialCookedAsset {
  readonly resolved: ResolvedMaterial;
  readonly passes: readonly MaterialCookedPass[];
  readonly layerPlan: StandardLayerPlan;
}

export type MaterialCookError = MaterialError | ShaderError;

const IMPORT_RE = /^\s*#import\s+([A-Za-z0-9_:-]+)/gm;

function newlineCount(source: string): number {
  return source.match(/\n/g)?.length ?? 0;
}

function mapCookErrorToAuthoredSource(
  error: ShaderError,
  authoredSource: string,
  composedSource: string,
): ShaderError {
  if (error.lineNum === undefined) return error;
  const header = /^(\s*#define_import_path[^\n]*(?:\r?\n|$))/m.exec(authoredSource);
  if (header === null) return error;
  const authoredRemainder = authoredSource.slice(header[0].length);
  const composedRemainder = composedSource.lastIndexOf(authoredRemainder);
  if (composedRemainder < 0) return error;
  const composedPrefix = composedSource.slice(0, composedRemainder);
  const offset = newlineCount(composedPrefix) - newlineCount(header[0]);
  if (offset <= 0 || error.lineNum <= newlineCount(composedPrefix)) return error;
  return new ShaderError({
    code: error.code,
    expected: error.expected,
    message: error.message,
    hint: error.hint,
    lineNum: error.lineNum - offset,
    ...(error.linePos === undefined ? {} : { linePos: error.linePos }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  });
}

function wgslType(parameter: ParamSchemaEntry): string {
  switch (parameter.type) {
    case 'f32':
      return 'f32';
    case 'i32':
      return 'i32';
    case 'u32':
      return 'u32';
    case 'vec2':
      return 'vec2<f32>';
    case 'vec3':
      return 'vec3<f32>';
    case 'vec4':
    case 'color':
      return 'vec4<f32>';
    case 'texture2d':
      return 'texture_2d<f32>';
    case 'texture2d_array':
      return 'texture_2d_array<f32>';
    case 'texture3d':
      return 'texture_3d<f32>';
    case 'texture_cube':
      return 'texture_cube<f32>';
    case 'texture_depth_2d':
      return 'texture_depth_2d';
    case 'texture_cube_array':
      return 'texture_cube_array<f32>';
    case 'sampler':
    case 'sampler_comparison':
      return 'sampler';
    case 'storage_buffer':
      return 'array<u32>';
  }
}

export interface GenerateParameterModuleOptions {
  /** Keep the generated struct/coordinate ABI but omit resource declarations. */
  readonly includeResources?: boolean;
}

export function generateParameterModule(
  schema: readonly ParamSchemaEntry[],
  options: GenerateParameterModuleOptions = {},
): string {
  const derived = derive(schema);
  const coordinateRecords = derived.coordinateRecords ?? [];
  const resourceBindings = derived.resourceBindings ?? [];
  const fields = schema
    .flatMap((parameter) => {
      if (isNumericParameter(parameter)) {
        return [`  ${parameter.name} : ${wgslType(parameter)},`];
      }
      if (isTextureParameter(parameter)) {
        const coordinates = coordinateRecords.find((record) => record.parameter === parameter.name);
        if (coordinates === undefined) return [];
        return [
          `  ${coordinates.transformMember} : vec4<f32>,`,
          `  ${coordinates.metadataMember} : vec4<f32>,`,
        ];
      }
      return [];
    })
    .join('\n');
  const lines = ['#define_import_path forgeax_material::parameters'];
  if (fields.length > 0) {
    lines.push(`struct MaterialParameters {\n${fields}\n}`);
  }

  const parameterByName = new Map(schema.map((parameter) => [parameter.name, parameter]));
  const uniformBinding = derived.bglEntries.find(
    (entry) => entry.buffer?.type === 'uniform',
  )?.binding;
  const declarations = new Map<number, string>();
  if (uniformBinding !== undefined) {
    declarations.set(
      uniformBinding,
      `@group(1) @binding(${uniformBinding}) var<uniform> material : MaterialParameters;`,
    );
  }
  if (options.includeResources !== false) {
    for (const resource of resourceBindings) {
      const parameter = parameterByName.get(resource.parameter ?? resource.name);
      if (parameter === undefined) continue;
      if (resource.kind === 'sampler') {
        declarations.set(
          resource.binding,
          `@group(1) @binding(${resource.binding}) var ${resource.name} : sampler;`,
        );
      } else if (resource.kind === 'texture') {
        declarations.set(
          resource.binding,
          `@group(1) @binding(${resource.binding}) var ${resource.name} : ${wgslType(parameter)};`,
        );
      } else {
        declarations.set(
          resource.binding,
          `@group(1) @binding(${resource.binding}) var ${resource.name} : array<u32>;`,
        );
      }
    }
  }
  for (const binding of [...declarations.keys()].sort((left, right) => left - right)) {
    lines.push(declarations.get(binding) as string);
  }
  return `${lines.join('\n')}\n`;
}

function isNumericParameter(parameter: ParamSchemaEntry): boolean {
  return ['f32', 'i32', 'u32', 'vec2', 'vec3', 'vec4', 'color'].includes(parameter.type);
}

function isTextureParameter(parameter: ParamSchemaEntry): boolean {
  return [
    'texture2d',
    'texture2d_array',
    'texture3d',
    'texture_cube',
    'texture_depth_2d',
    'texture_cube_array',
  ].includes(parameter.type);
}

function hasAuthoredMaterialInterface(source: string): boolean {
  return (
    /\bstruct\s+Material\s*\{/.test(source) &&
    /@group\(1\)\s*@binding\(0\)\s*var<uniform>\s+material\s*:\s*Material\s*;/.test(source)
  );
}

function importModuleIds(source: string): readonly string[] {
  const ids: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const raw = match[1];
    if (raw !== undefined) ids.push(raw.replace(/::$/, '').split('::{')[0] ?? raw);
  }
  return ids;
}

function collectSourceClosure(
  source: string,
  sources: MaterialSourceCatalog,
  generated: string,
): Result<Readonly<Record<string, string>>, MaterialError> {
  const result: Record<string, string> = { 'forgeax_material::parameters': generated };
  const pending = [...importModuleIds(source)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const moduleId = pending.shift();
    if (moduleId === undefined || visited.has(moduleId)) continue;
    visited.add(moduleId);
    if (moduleId === 'forgeax_material::parameters') continue;
    const record = sources.get(moduleId);
    if (!record.ok) return err(record.error);
    result[moduleId] = record.value.source;
    pending.push(...importModuleIds(record.value.source));
  }
  return ok(result);
}

function applyModuleSlots(
  source: string,
  sourceModuleId: string,
  moduleSlots: Readonly<Record<string, string>> | undefined,
  sources: MaterialSourceCatalog,
): Result<string, MaterialError> {
  let selectedSource = source;
  for (const [slotName, moduleId] of Object.entries(moduleSlots ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const selected = sources.resolveSlot(sourceModuleId, slotName, moduleId);
    if (!selected.ok) return err(selected.error);
    const marker = new RegExp(
      `(\\#import\\s+forgeax_material::slot::${slotName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}::\\{[^\\n]+\\})`,
      'g',
    );
    if (!marker.test(selectedSource)) {
      return err(
        createMaterialError('shader-module-not-found', {
          code: 'shader-module-not-found',
          module: `${sourceModuleId}::${slotName}=${moduleId}`,
          source: sourceModuleId,
        }),
      );
    }
    selectedSource = selectedSource.replace(marker, (line) =>
      line.replace(`forgeax_material::slot::${slotName}`, selected.value.moduleId),
    );
  }
  return ok(selectedSource);
}

export async function cookMaterialAsset(
  request: MaterialCookRequest,
): Promise<Result<MaterialCookedAsset, MaterialCookError>> {
  const resolved = resolveMaterialAsset(request.material, request.table);
  if (!resolved.ok) return err(resolved.error);
  const parameters = resolved.value.asset.parameters ?? [];
  const loweredContract = lowerStandardContract(parameters, resolved.value.asset.passes);
  if (!loweredContract.ok) return loweredContract;
  const { layerPlan } = loweredContract.value;
  const schema = ok(loweredContract.value.paramSchema);
  const derived: DerivedMaterialInterface = derive(schema.value);
  const generatedModule = generateParameterModule(schema.value);
  const generatedInterfaceModule = generateParameterModule(schema.value, {
    includeResources: false,
  });
  const cooked: MaterialCookedPass[] = [];

  for (const pass of resolved.value.asset.passes ?? []) {
    const tags = pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined;
    const lightMode = tags?.LightMode ?? pass.name;
    const context: MaterialVariantContext = {
      ...(request.context ?? DEFAULT_MATERIAL_VARIANT_CONTEXT),
      pipeline: /deferred|gbuffer/i.test(String(lightMode))
        ? 'deferred'
        : (request.context ?? DEFAULT_MATERIAL_VARIANT_CONTEXT).pipeline,
      pass: /shadow/i.test(String(lightMode))
        ? 'shadow'
        : /depth/i.test(String(lightMode))
          ? 'depth'
          : 'forward',
    };
    const sourceRecord = request.sources.get(pass.program.module);
    if (!sourceRecord.ok) return err(sourceRecord.error);
    const source = sourceRecord.value.source;
    const standardTemplate = isStandardRootModule(pass.program.module);
    const usesSurfaceSlot = sourceRecord.value.slots.includes('surface');
    let composedSource: Result<string, MaterialError>;
    let imports: Result<Readonly<Record<string, string>>, MaterialError>;
    let sourceClosure: readonly string[];
    let sourceClosureDigest: string;
    if (usesSurfaceSlot) {
      const surface = composeSurfaceSource({
        material: request.material,
        pass: pass.name,
        templateModule: pass.program.module,
        sources: request.sources,
        generatedParameters:
          standardTemplate ||
          pass.program.module === 'forgeax_material::standard' ||
          pass.program.module === 'forgeax_material::pbr-skin'
            ? generatedInterfaceModule
            : generatedModule,
        ...(pass.program.moduleSlots?.surface === undefined
          ? {}
          : { surfaceModule: pass.program.moduleSlots.surface }),
      });
      if (!surface.ok) return surface;
      composedSource = ok(surface.value.source);
      imports = ok(surface.value.imports);
      sourceClosure = surface.value.sourceClosure;
      sourceClosureDigest = surface.value.sourceClosureDigest;
    } else {
      composedSource = applyModuleSlots(
        source,
        pass.program.module,
        pass.program.moduleSlots,
        request.sources,
      );
      if (!composedSource.ok) return composedSource;
      imports = collectSourceClosure(composedSource.value, request.sources, generatedModule);
      if (!imports.ok) return imports;
      sourceClosure = [sourceRecord.value.path, ...Object.keys(imports.value).sort()];
      sourceClosureDigest = digestMaterialSourceClosure({
        [sourceRecord.value.path]: source,
        ...imports.value,
      });
    }
    const sourceWithInterface =
      composedSource.value.includes('forgeax_material::parameters') ||
      composedSource.value.includes('struct MaterialParameters') ||
      hasAuthoredMaterialInterface(composedSource.value)
        ? composedSource.value
        : composedSource.value.replace(
            /^(\s*#define_import_path\s+[^\n]+\n?)/,
            `$1${generatedModule.replace(/^#define_import_path[^\n]+\n?/, '')}\n`,
          );
    const loweredSource =
      standardTemplate ||
      pass.program.module === 'forgeax_material::standard' ||
      pass.program.module === 'forgeax_material::pbr-skin'
        ? lowerStandardPhysicalBindings(sourceWithInterface, schema.value)
        : sourceWithInterface;
    const fragmentEntry =
      pass.program.fragmentEntry ??
      (context.pass === 'depth'
        ? undefined
        : context.pass === 'shadow'
          ? 'fs_shadow'
          : context.pipeline === 'deferred'
            ? 'fs_gbuffer'
            : 'fs_main');
    const compiled = await compileShader(loweredSource, {
      id: `${pass.program.module}::${pass.name}`,
      renderEntries: {
        vertex: pass.program.vertexEntry ?? 'vs_main',
        ...(fragmentEntry === undefined ? {} : { fragment: fragmentEntry }),
      },
      imports: imports.value,
      defines: {
        ...lowerMaterialVariantContext(context),
        ...loweredContract.value.defines,
      },
    });
    if (!compiled.ok) {
      return err(mapCookErrorToAuthoredSource(compiled.error, source, loweredSource));
    }
    const relocatedTextures = new Set(
      standardTemplate ? standardPhysicalTextureFields(schema.value) : [],
    );
    if (!hasAuthoredMaterialInterface(composedSource.value)) {
      const checked = compareMaterialBindings(
        schema.value,
        compiled.value.bindings,
        pass.program.module,
        relocatedTextures,
      );
      if (!checked.ok) return checked;
    }
    const reflectionChecked = compareDerivedMaterialInterface(
      derived,
      compiled.value.reflection,
      relocatedTextures,
      standardTemplate,
    );
    if (!reflectionChecked.ok) {
      return err({
        ...reflectionChecked.error,
        detail: {
          ...reflectionChecked.error.detail,
          material: request.material,
          pass: pass.name,
          module: pass.program.module,
          source: sourceRecord.value.path,
          context: { ...context },
        },
      });
    }
    cooked.push({
      pass: pass.name,
      context,
      module: pass.program.module,
      parameters,
      paramSchema: schema.value,
      generatedModule,
      sourceClosure,
      sourceClosureDigest,
      compile: compiled.value,
      layoutIdentity: derived.layoutIdentity,
    });
  }

  return ok({ resolved: resolved.value, passes: cooked, layerPlan });
}
