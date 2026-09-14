import {
  createMaterialError,
  err,
  type MaterialError,
  ok,
  type Result,
  type StandardLayerPlan,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CompileResult } from '../index.js';
import {
  buildMaterialSourceCatalog,
  type MaterialSourceCatalog,
  type MaterialSourceInput,
} from './source-catalog.js';
import { validateSurfaceDependency, validateSurfaceSource } from './surface-contract.js';
import { lowerMaterialVariantContext, type MaterialVariantContext } from './variant-context.js';

export interface MaterialComposeRequest {
  readonly material: string;
  readonly pass: string;
  readonly source: string;
  readonly imports?: Readonly<Record<string, string>>;
  readonly moduleSlots?: Readonly<Record<string, string>>;
  readonly context?: MaterialVariantContext;
  readonly layerPlan?: StandardLayerPlan;
}

export interface MaterialComposedSource {
  readonly wgsl: string;
  readonly bindings: readonly unknown[];
  readonly deps: readonly string[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
}

export interface ComposedMaterial {
  readonly material: string;
  readonly pass: string;
  readonly wgsl: string;
  readonly bindings: readonly unknown[];
  readonly deps: readonly string[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
}

export type MaterialComposeCompiler = (
  request: MaterialComposeRequest,
) => Promise<MaterialComposedSource | CompileResult>;

export type SurfaceCompositionStage =
  | 'slot-resolution'
  | 'source-closure'
  | 'surface-validation'
  | 'parameter-generation';

export interface SurfaceCompositionRequest {
  readonly material: string;
  readonly pass: string;
  readonly templateModule: string;
  readonly surfaceModule?: string;
  readonly sources: MaterialSourceCatalog;
  readonly generatedParameters?: string;
}

export interface SurfaceComposition {
  readonly source: string;
  readonly templateModule: string;
  readonly surfaceModule: string;
  readonly imports: Readonly<Record<string, string>>;
  readonly sourceClosure: readonly string[];
  readonly sourceClosureDigest: string;
  readonly stages: readonly SurfaceCompositionStage[];
}

export interface StandardSourcePreparationRequest {
  readonly material: string;
  readonly pass?: string;
  readonly templateModule: string;
  readonly templatePath: string;
  readonly templateSource: string;
  readonly surfaceModule?: string;
  readonly sourceRecords: readonly MaterialSourceInput[];
  readonly generatedParameters?: string;
}

export interface PreparedStandardSource {
  readonly source: string;
  readonly imports: Readonly<Record<string, string>>;
  readonly sourceClosure: readonly string[];
  readonly sourceClosureDigest: string;
}

const IMPORT_RE = /^\s*#import\s+([A-Za-z0-9_:-]+)/gm;

const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path[^\n]*\n?/m;

function importedModules(source: string): readonly string[] {
  return [...source.matchAll(IMPORT_RE)]
    .map((match) => match[1]?.replace(/::$/, '').split('::{')[0])
    .filter((module): module is string => module !== undefined);
}

const SURFACE_INPUT_FIELDS = [
  ['positionOS', 'vec3<f32>'],
  ['positionWS', 'vec3<f32>'],
  ['geometricNormalWS', 'vec3<f32>'],
  ['tangentWS', 'vec4<f32>'],
  ['viewDirectionWS', 'vec3<f32>'],
  ['uv0', 'vec2<f32>'],
  ['uv1', 'vec2<f32>'],
  ['vertexColor', 'vec4<f32>'],
  ['frontFacing', 'bool'],
] as const;

const SURFACE_DATA_FIELDS = [
  ['baseColor', 'vec3<f32>'],
  ['normalWS', 'vec3<f32>'],
  ['metallic', 'f32'],
  ['roughness', 'f32'],
  ['emissive', 'vec3<f32>'],
  ['occlusion', 'f32'],
  ['opacity', 'f32'],
  ['alphaClipThreshold', 'f32'],
] as const;

function validateSurfaceAbi(
  request: SurfaceCompositionRequest,
  source: { readonly path: string; readonly source: string },
): Result<true, MaterialError> {
  const check = (structName: string, fields: readonly (readonly [string, string])[]) => {
    const body = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(
      source.source,
    )?.[1];
    if (body === undefined) return `missing struct ${structName}`;
    let cursor = 0;
    for (const [index, [name, type]] of fields.entries()) {
      const suffix = index === fields.length - 1 ? '(?:\\s*,|\\s*$)' : '\\s*,';
      const field = new RegExp(`\\b${name}\\s*:\\s*${type.replace(/[<>]/g, '\\$&')}${suffix}`).exec(
        body.slice(cursor),
      );
      if (field === null) return `${structName}.${name} must be ${type}`;
      cursor += (field.index ?? 0) + field[0].length;
    }
    return undefined;
  };
  const actual =
    check('SurfaceInput', SURFACE_INPUT_FIELDS) ?? check('SurfaceData', SURFACE_DATA_FIELDS);
  if (actual !== undefined) {
    return err(
      createMaterialError('material-surface-abi-mismatch', {
        code: 'material-surface-abi-mismatch',
        material: request.material,
        pass: request.pass,
        source: source.path,
        slot: 'surface',
        expected: 'surface_v1 canonical SurfaceInput/SurfaceData field order',
        actual,
        action: 'repair-surface-export',
      }),
    );
  }
  return ok(true);
}

/**
 * Lower the selected Surface and ABI into the Standard entry. Keeping both
 * structs in the entry gives the compiler one lexical material namespace and
 * avoids a second import path for the authored Surface ABI.
 */
function inlineSurfaceImplementation(
  templateSource: string,
  selectedSource: string,
  surfaceAbiSource: string,
  generatedParameters: string,
): string {
  // Keep every remaining import in its original preprocessor context. Moving
  // guarded imports to the entry header would make optional cluster/projector
  // modules unconditional and would change the variant's binding contract.
  const templateBody = templateSource
    .replace(
      /^\s*#import\s+forgeax_material::(?:slot::surface|surface_v1|parameters)[^\n]*\n?/gm,
      '',
    )
    .replace(/^\s*#pragma\s+material_slot\s+surface[^\n]*\n?/gm, '')
    .replace(DEFINE_IMPORT_PATH_RE, '');
  const selectedBody = selectedSource
    .replace(/^\s*#import\s+forgeax_material::(?:surface_v1|parameters)[^\n]*\n?/gm, '')
    .replace(DEFINE_IMPORT_PATH_RE, '');
  const abiBody = surfaceAbiSource.replace(DEFINE_IMPORT_PATH_RE, '');
  const parameters = generatedParameters.replace(DEFINE_IMPORT_PATH_RE, '');
  const commonImport =
    templateBody.match(/^\s*#import\s+forgeax_view::common[^\n]*\n?/m)?.[0] ?? '';
  const templateWithoutCommonImport =
    commonImport.length === 0 ? templateBody : templateBody.replace(commonImport, '');
  // Keep the template declarations before the selected implementation. WGSL
  // name resolution in naga_oil is declaration-ordered for global resources;
  // placing evaluate_surface ahead of the template's texture declarations
  // would make otherwise valid references (for example baseColorTexture)
  // appear out of scope. The template's remaining imports stay in-place and
  // are still resolved under their original #ifdef guards.
  return `// composed Surface entry\n${commonImport}${parameters}\n${abiBody}\n${templateWithoutCommonImport}\n${selectedBody}`;
}

function hasAuthoredMaterialInterface(source: string): boolean {
  return (
    /\bstruct\s+Material\s*\{/.test(source) &&
    /@group\(1\)\s*@binding\(0\)\s*var<uniform>\s+material\s*:\s*Material\s*;/.test(source)
  );
}

function closureDigest(imports: Readonly<Record<string, string>>): string {
  const preimage = [...Object.entries(imports)]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([module, source]) => `${module}\n${source}`)
    .join('\n');
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(preimage)))}`;
}

/**
 * Hash a material's resolved source closure with the same canonical ordering
 * used by Surface composition. Pack receipts use this helper so the digest
 * is owned by the compiler closure rather than by a second cooker algorithm.
 */
export function digestMaterialSourceClosure(sources: Readonly<Record<string, string>>): string {
  return closureDigest(sources);
}

/**
 * Prepare a Standard template through the same catalog and Surface lowering
 * used by Pack cooking. This keeps the Vite/manifest entry path from feeding
 * naga a second, imported Surface ABI representation.
 */
export function prepareStandardSource(
  request: StandardSourcePreparationRequest,
): Result<PreparedStandardSource, MaterialError> {
  const catalog = buildMaterialSourceCatalog({
    engine: [
      { path: request.templatePath, source: request.templateSource },
      ...request.sourceRecords.filter((record) => record.path !== request.templatePath),
    ],
    project: [],
  });
  if (!catalog.ok) return err(catalog.error);
  const composed = composeSurfaceSource({
    material: request.material,
    pass: request.pass ?? 'Forward',
    templateModule: request.templateModule,
    ...(request.surfaceModule === undefined ? {} : { surfaceModule: request.surfaceModule }),
    sources: catalog.value,
    ...(request.generatedParameters === undefined
      ? {}
      : { generatedParameters: request.generatedParameters }),
  });
  if (!composed.ok) return composed;
  return ok({
    source: composed.value.source,
    imports: composed.value.imports,
    sourceClosure: composed.value.sourceClosure,
    sourceClosureDigest: composed.value.sourceClosureDigest,
  });
}

/** Resolve and validate the sole Standard Surface slot at build time. */
export function composeSurfaceSource(
  request: SurfaceCompositionRequest,
): Result<SurfaceComposition, MaterialError> {
  const template = request.sources.get(request.templateModule);
  if (!template.ok) return err(template.error);
  const selected = request.sources.resolveSurfaceSlot(
    request.material,
    request.pass,
    request.templateModule,
    request.surfaceModule,
  );
  if (!selected.ok) return err(selected.error);

  const validated = validateSurfaceSource({
    material: request.material,
    pass: request.pass,
    source: selected.value.source,
    sourcePath: selected.value.path,
  });
  if (!validated.ok) return err(validated.error);

  const surfaceAbi = request.sources.get('forgeax_material::surface_v1');
  if (!surfaceAbi.ok) return err(surfaceAbi.error);
  const validAbi = validateSurfaceAbi(request, surfaceAbi.value);
  if (!validAbi.ok) return validAbi;

  const generatedParameters =
    request.generatedParameters ?? '#define_import_path forgeax_material::parameters\n';
  const parameterSource = hasAuthoredMaterialInterface(template.value.source)
    ? ''
    : generatedParameters;
  const source = inlineSurfaceImplementation(
    template.value.source,
    selected.value.source,
    surfaceAbi.value.source,
    parameterSource,
  );
  const imports: Record<string, string> = {};
  const closureSources: Record<string, string> = {
    [request.templateModule]: template.value.source,
    ...(parameterSource.length === 0 ? {} : { 'forgeax_material::parameters': parameterSource }),
    'forgeax_material::surface_v1': surfaceAbi.value.source,
    [selected.value.moduleId]: selected.value.source,
  };
  const queue = [
    ...importedModules(template.value.source).map((module) => ({
      module,
      surfaceDependency: false,
    })),
    ...importedModules(selected.value.source).map((module) => ({
      module,
      surfaceDependency: true,
    })),
  ];
  const visited = new Set<string>();
  const validatedSurfaceDependencies = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) continue;
    const module = next.module;
    if (
      module === request.templateModule ||
      module === 'forgeax_material::surface_v1' ||
      module === 'forgeax_material::slot::surface' ||
      module === selected.value.moduleId ||
      module === 'forgeax_material::parameters'
    )
      continue;
    const needsSurfaceValidation =
      next.surfaceDependency && !validatedSurfaceDependencies.has(module);
    if (visited.has(module) && !needsSurfaceValidation) continue;
    const record = request.sources.get(module);
    if (!record.ok) return err(record.error);
    if (needsSurfaceValidation) {
      const dependency = validateSurfaceDependency({
        material: request.material,
        pass: request.pass,
        source: record.value.source,
        sourcePath: record.value.path,
      });
      if (!dependency.ok) return err(dependency.error);
      validatedSurfaceDependencies.add(module);
    }
    if (visited.has(module)) continue;
    visited.add(module);
    imports[module] = record.value.source;
    closureSources[module] = record.value.source;
    queue.push(
      ...importedModules(record.value.source).map((child) => ({
        module: child,
        surfaceDependency: next.surfaceDependency,
      })),
    );
  }
  const sourceClosure = Object.keys(closureSources).sort();
  return ok({
    source,
    templateModule: request.templateModule,
    surfaceModule: selected.value.moduleId,
    imports,
    sourceClosure,
    sourceClosureDigest: closureDigest(closureSources),
    stages: ['slot-resolution', 'source-closure', 'surface-validation', 'parameter-generation'],
  });
}

function isCompileResult(value: MaterialComposedSource | CompileResult): value is CompileResult {
  return 'manifestEntry' in value;
}

export async function composeMaterial(
  request: MaterialComposeRequest,
  compiler?: MaterialComposeCompiler,
): Promise<Result<ComposedMaterial, unknown>> {
  const compile =
    compiler ??
    (async (input) => {
      const { compileShader } = await import('../index.js');
      const options = {
        id: `${input.material}::${input.pass}`,
        ...(input.imports === undefined ? {} : { imports: { ...input.imports } }),
        ...(input.context === undefined
          ? {}
          : { defines: { ...lowerMaterialVariantContext(input.context) } }),
      };
      const result = await compileShader(input.source, options);
      if (!result.ok) return result as never;
      return result.value;
    });
  const result = await compile(request);
  if (!result || typeof result !== 'object') return err(result);
  if (isCompileResult(result)) {
    return ok({
      material: request.material,
      pass: request.pass,
      wgsl: result.wgsl,
      bindings: result.bindings,
      deps: result.deps,
      vertexInputs: [],
    });
  }
  return ok({
    material: request.material,
    pass: request.pass,
    wgsl: result.wgsl,
    bindings: result.bindings,
    deps: result.deps,
    vertexInputs: result.vertexInputs,
  });
}
