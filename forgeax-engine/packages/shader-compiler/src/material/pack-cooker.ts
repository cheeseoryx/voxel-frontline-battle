import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { isStandardRootModule } from '@forgeax/engine-pack';
import {
  type MaterialCookWasmProvenance,
  serializeCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { MaterialAsset, MaterialPass, MaterialTable } from '@forgeax/engine-types';
import { cookMaterialAsset } from './cook.js';
import { cookedRecord, materialPrograms } from './publication.js';
import { buildMaterialSourceCatalog } from './source-catalog.js';

interface MaterialPackCookInput {
  readonly guid: string;
  readonly source: MaterialAsset;
  readonly sourceKey?: string;
  readonly sourcePath?: string;
  readonly refs?: readonly string[];
  readonly compilerFingerprint?: string;
  readonly wasm?: MaterialCookWasmProvenance;
  readonly table?: MaterialTable;
}

interface MaterialSourceFile {
  readonly path: string;
  readonly source: string;
  readonly moduleId: string;
}

const require = createRequire(import.meta.url);
const MODULE_ID_RE = /^\s*#define_import_path\s+([A-Za-z0-9_-]+(?:::[A-Za-z0-9_-]+)*)\s*$/m;
const ENGINE_MODULE_ALIASES: Readonly<Record<string, string>> = {
  'forgeax_material::standard': 'forgeax::default-standard-pbr',
  'forgeax_material::unlit': 'forgeax::default-unlit',
  'forgeax_material::pbr-skin': 'forgeax::pbr-skin',
  'forgeax_material::sprite': 'forgeax::sprite',
  'forgeax_material::sprite-lit': 'forgeax::sprite-lit',
};

function moduleIdOf(source: string): string | undefined {
  return MODULE_ID_RE.exec(source)?.[1];
}

function isEngineModule(moduleId: string): boolean {
  return moduleId.startsWith('forgeax_') || moduleId.startsWith('forgeax::');
}

async function collectWgslFiles(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) files.push(...(await collectWgslFiles(path)));
      else if (entry.isFile() && path.endsWith('.wgsl')) files.push(path);
    }
    return files.sort();
  } catch {
    return root.endsWith('.wgsl') ? [root] : [];
  }
}

function packagedShaderRoots(): readonly string[] {
  const roots = [
    resolve(process.cwd(), 'packages/shader/src'),
    resolve(process.cwd(), 'packages/vfx-render/src/shaders'),
  ];
  for (const [packageName, relativePath] of [
    ['@forgeax/engine-shader', 'src'],
    ['@forgeax/engine-vfx-render', 'src/shaders'],
  ] as const) {
    try {
      roots.push(resolve(dirname(require.resolve(`${packageName}/package.json`)), relativePath));
    } catch {
      // Published SDKs may omit source roots that are not needed by a project.
    }
  }
  return [...new Set(roots)];
}

export async function collectMaterialSources(
  roots: readonly string[],
  engineRoots: readonly string[] = [],
): Promise<{
  readonly engine: readonly MaterialSourceFile[];
  readonly project: readonly MaterialSourceFile[];
}> {
  const files = [...new Set((await Promise.all(roots.map(collectWgslFiles))).flat())].sort();
  const shadowCasterPaths = new Set(engineRoots.map((root) => resolve(root, 'shadow_caster.wgsl')));
  const records: MaterialSourceFile[] = [];
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    // shadow_caster is a reserved Engine entry whose source intentionally has
    // no import-path directive. Keep that ownership fact in the producer
    // catalog instead of forcing every authored MaterialAsset to special-case
    // the module.
    const shadowCaster = shadowCasterPaths.has(path);
    const moduleId =
      moduleIdOf(source) ?? (shadowCaster ? 'forgeax::default-shadow-caster' : undefined);
    if (moduleId !== undefined) {
      records.push({
        path,
        source: shadowCaster ? `#define_import_path ${moduleId}\n${source}` : source,
        moduleId,
      });
    }
  }
  for (const record of [...records]) {
    const alias = ENGINE_MODULE_ALIASES[record.moduleId];
    if (alias === undefined) continue;
    records.push({
      ...record,
      moduleId: alias,
      source: record.source.replace(
        /^\s*#define_import_path\s+[^\s]+/m,
        `#define_import_path ${alias}`,
      ),
    });
  }
  return {
    engine: records.filter((record) => isEngineModule(record.moduleId)),
    project: records.filter((record) => !isEngineModule(record.moduleId)),
  };
}

function materialInput(value: unknown): MaterialPackCookInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('material cooker expected an object input');
  }
  const input = value as Partial<MaterialPackCookInput>;
  if (
    typeof input.guid !== 'string' ||
    input.source === undefined ||
    input.source === null ||
    input.source.kind !== 'material'
  ) {
    throw new Error('material cooker expected a MaterialAsset source');
  }
  return input as MaterialPackCookInput;
}

/**
 * Pack JSON keeps the authored pass intentionally small, but the renderer's
 * selector consumes the same LightMode tag that built-in Standard materials
 * publish.  Derive that policy at the Pack boundary so a cooked asset and an
 * in-memory Standard material enter the render graph with one pass identity.
 */
function normalizeMaterialPass(pass: MaterialPass): MaterialPass {
  const tags = pass.renderState?.tags;
  if (tags !== undefined && typeof tags === 'object' && tags !== null && 'LightMode' in tags) {
    return pass;
  }
  const lightMode =
    pass.name.toLowerCase() === 'shadow-caster'
      ? 'ShadowCaster'
      : pass.name.toLowerCase() === 'deferred'
        ? 'Deferred'
        : pass.name.toLowerCase() === 'forward'
          ? 'Forward'
          : undefined;
  if (lightMode === undefined) return pass;
  return {
    ...pass,
    renderState: {
      ...(pass.renderState ?? {}),
      tags: {
        LightMode: lightMode,
        ...(tags as Record<string, unknown> | undefined),
      },
    },
  };
}

function normalizeMaterialAsset(source: MaterialAsset): MaterialAsset {
  const sourcePasses = source.passes;
  if (sourcePasses === undefined) return source;
  const passes = sourcePasses.map(normalizeMaterialPass);
  if (passes.every((pass, index) => pass === sourcePasses[index])) return source;
  return {
    ...source,
    passes: passes as unknown as NonNullable<MaterialAsset['passes']>,
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function inputDigest(
  sourceClosure: readonly string[],
  sourceRecords: readonly MaterialSourceFile[],
): string {
  const closurePaths = new Set(sourceClosure);
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        modules: sourceRecords
          .filter((record) => closurePaths.has(record.path) || closurePaths.has(record.moduleId))
          .map((record) => ({ moduleId: record.moduleId, source: record.source }))
          .sort((left, right) => left.moduleId.localeCompare(right.moduleId)),
        declaredSources: sourceRecords.filter(
          (record) => closurePaths.has(record.path) || closurePaths.has(record.moduleId),
        ).length,
      }),
    )
    .digest('hex')}`;
}

/**
 * Material Packs may give an engine-owned Standard source a project-owned
 * module identity (for example a physical-material case alias).  The Vite
 * shader producer performs the same header projection before compiling the
 * manifest; keep Pack cooking on that one source route instead of requiring a
 * copied WGSL file just to make the alias discoverable.
 */
function materialModuleAliases(
  sources: {
    readonly engine: readonly MaterialSourceFile[];
    readonly project: readonly MaterialSourceFile[];
  },
  input: MaterialPackCookInput,
): readonly MaterialSourceFile[] {
  if (input.sourcePath === undefined || input.sourceKey === undefined) return [];
  const sourcePath = resolve(dirname(resolve(input.sourcePath)), input.sourceKey);
  const source = [...sources.engine, ...sources.project].find(
    (candidate) => resolve(candidate.path) === sourcePath,
  );
  if (source === undefined) return [];
  const existing = new Set(
    [...sources.engine, ...sources.project].map((candidate) => candidate.moduleId),
  );
  const aliases = new Map<string, MaterialSourceFile>();
  for (const pass of input.source.passes ?? []) {
    const moduleId = pass.program.module;
    if (moduleId === source.moduleId || existing.has(moduleId) || aliases.has(moduleId)) continue;
    aliases.set(moduleId, {
      ...source,
      moduleId,
      source: source.source.replace(/^(\s*#define_import_path\s+)[^\n]+/m, `$1${moduleId}`),
    });
  }
  return [...aliases.values()];
}

/** Build a Pack NativeCooker for authored WGSL material rows. */
export function createMaterialPackCooker(roots: readonly string[] = []): NativeCooker {
  return {
    key: 'material',
    async cook(rawInput: unknown) {
      const input = materialInput(rawInput);
      let normalizedInput: MaterialPackCookInput = {
        ...input,
        source: normalizeMaterialAsset(input.source),
      };
      const packagedRoots = packagedShaderRoots();
      const sourceRoots = [
        ...roots,
        ...(input.sourcePath === undefined ? [] : [dirname(resolve(input.sourcePath))]),
        ...packagedRoots,
      ];
      const sources = await collectMaterialSources(sourceRoots, packagedRoots);
      const aliases = materialModuleAliases(sources, normalizedInput);
      // An alias of an Engine-owned template retains that template's identity.
      // Project names and arbitrary Surface slots do not select Standard policy.
      const standardAliases = new Map(
        aliases.flatMap((alias) => {
          const owner = sources.engine.find(
            (source) => source.path === alias.path && isStandardRootModule(source.moduleId),
          );
          return owner === undefined ? [] : [[alias.moduleId, owner.moduleId] as const];
        }),
      );
      if (standardAliases.size > 0 && normalizedInput.source.passes !== undefined) {
        normalizedInput = {
          ...normalizedInput,
          source: {
            ...normalizedInput.source,
            passes: normalizedInput.source.passes.map((pass) => ({
              ...pass,
              program: {
                ...pass.program,
                module: standardAliases.get(pass.program.module) ?? pass.program.module,
              },
            })) as unknown as NonNullable<MaterialAsset['passes']>,
          },
        };
      }
      const catalog = buildMaterialSourceCatalog({
        roots: sourceRoots,
        engine: sources.engine,
        project: [
          ...sources.project,
          ...aliases.filter((alias) => !standardAliases.has(alias.moduleId)),
        ],
      });
      if (!catalog.ok) {
        throw catalog.error;
      }
      const cooked = await cookMaterialAsset({
        material: normalizedInput.guid,
        table: {
          ...(input.table ?? {}),
          [normalizedInput.guid]: normalizedInput.source,
        },
        sources: catalog.value,
      });
      if (!cooked.ok) {
        throw cooked.error;
      }
      const layoutIdentity = cooked.value.passes[0]?.layoutIdentity;
      if (layoutIdentity === undefined) {
        throw new Error('material shader compile produced no passes');
      }
      if (cooked.value.passes.some((pass) => pass.layoutIdentity !== layoutIdentity)) {
        throw new Error('material shader passes produced different layout identities');
      }
      const programs = materialPrograms(cooked.value.passes, normalizedInput);
      const sourceClosure = unique([
        ...(normalizedInput.sourcePath === undefined ? [] : [resolve(normalizedInput.sourcePath)]),
        ...(normalizedInput.sourceKey === undefined || normalizedInput.sourcePath === undefined
          ? []
          : [resolve(dirname(resolve(normalizedInput.sourcePath)), normalizedInput.sourceKey)]),
        ...cooked.value.passes.flatMap((pass) => pass.sourceClosure),
      ]);
      const passClosureDigests = [
        ...new Set(cooked.value.passes.map((pass) => pass.sourceClosureDigest)),
      ].sort();
      const fingerprint =
        passClosureDigests.length === 1 && passClosureDigests[0] !== undefined
          ? passClosureDigests[0]
          : inputDigest(sourceClosure, [...sources.engine, ...sources.project]);
      const record = cookedRecord(
        normalizedInput,
        cooked.value.resolved.asset,
        sourceClosure,
        layoutIdentity,
        programs,
        fingerprint,
        cooked.value.layerPlan.identity,
      );
      return {
        guid: normalizedInput.guid,
        payload: {
          ...normalizedInput.source,
          cooked: JSON.parse(serializeCookedMaterialRecord(record)) as Record<string, unknown>,
        },
        refs: unique([
          ...(normalizedInput.refs ?? []),
          ...record.refs.parent,
          ...record.refs.textures,
          ...record.refs.samplers,
        ]),
        artifacts: Object.fromEntries(
          programs.map(({ artifact }) => [
            artifact.path,
            { mediaType: artifact.mediaType, bytes: artifact.bytes },
          ]),
        ),
        inputFingerprint: fingerprint,
      };
    },
  };
}
