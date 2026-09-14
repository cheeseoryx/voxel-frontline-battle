import type { Dirent } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { GameProjectPluginEntry } from '@forgeax/engine-project';
import type { ProjectFacts } from '../types.js';

export type ProjectLintRuleId =
  | 'project-ownership-orphan'
  | 'project-ownership-multi-owner'
  | 'project-realm-invalid'
  | 'project-provider-missing'
  | 'project-legacy-field'
  | 'project-schema-invalid'
  | 'project-reader-error'
  | 'project-ownership-cycle';

type ProjectLintDiagnosticBase = {
  readonly ownerPath: string;
  readonly expected: string;
  readonly hint: string;
};

export type ProjectLintDiagnostic =
  | (ProjectLintDiagnosticBase & {
      readonly ruleId: 'project-ownership-orphan';
      readonly detail: { readonly module: string; readonly reason?: string };
    })
  | (ProjectLintDiagnosticBase & {
      readonly ruleId: 'project-ownership-multi-owner';
      readonly detail: { readonly module: string; readonly owners: readonly string[] };
    })
  | (ProjectLintDiagnosticBase & {
      readonly ruleId: 'project-realm-invalid';
      readonly detail: { readonly id?: string; readonly realm?: string; readonly module?: string };
    })
  | (ProjectLintDiagnosticBase & {
      readonly ruleId: 'project-provider-missing';
      readonly detail: {
        readonly service: string;
        readonly module: string;
        readonly realm?: string;
      };
    })
  | (ProjectLintDiagnosticBase & {
      readonly ruleId: 'project-legacy-field';
      readonly detail: { readonly field: string; readonly source?: string };
    })
  | (ProjectLintDiagnosticBase & {
      readonly ruleId: 'project-schema-invalid';
      readonly detail: {
        readonly code?: string;
        readonly issues?: readonly unknown[];
        readonly reason?: string;
      };
    })
  | (ProjectLintDiagnosticBase & {
      readonly ruleId: 'project-reader-error';
      readonly detail: { readonly code: string; readonly root?: string; readonly reason?: string };
    })
  | (ProjectLintDiagnosticBase & {
      readonly ruleId: 'project-ownership-cycle';
      readonly detail: { readonly module: string; readonly cycle: readonly string[] };
    });

export interface ProjectOwnershipNode {
  readonly module: string;
  readonly ownerPath: string;
  readonly realm: 'host' | 'engine' | 'build';
  readonly source: 'manifest' | 'static-import' | 'plugin-edge';
}

export interface ProjectOwnershipGraph {
  readonly ownership: readonly ProjectOwnershipNode[];
  readonly diagnostics: readonly ProjectLintDiagnostic[];
}

interface ModuleRecord {
  readonly module: string;
  readonly ownerPath: string;
  readonly realm: 'host' | 'engine' | 'build';
  readonly source: ProjectOwnershipNode['source'];
  readonly sourceText?: string;
}

interface PluginEdge {
  readonly module: string;
  readonly binding: string;
}

// These services are installed by the App host before a project's Engine
// EntryTree is reconciled. They are runtime owner facts, not a second project
// registry: lint only projects their stable service names so a local feature
// can depend on the same capabilities it receives at runtime.
const APP_ENGINE_PROVIDERS = new Set(['world', 'renderer', 'assets', 'input', 'gameHost']);

// Public umbrella presets are external modules, so their implementation source
// is intentionally outside the project graph. Keep their native provider fact
// here rather than treating every unknown external package as a provider.
const EXTERNAL_PLUGIN_PROVIDERS = new Map<string, readonly string[]>([
  ['@forgeax/engine/physics/rapier2d', ['physics']],
  ['@forgeax/engine/physics/rapier3d', ['physics']],
]);

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function relativeModule(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function isLocalModule(name: string): boolean {
  return name.startsWith('./') || name.startsWith('../');
}

async function findLocalModule(root: string, specifier: string): Promise<string | undefined> {
  const base = resolve(root, specifier);
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next explicit source extension.
    }
  }
  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = resolve(base, `index${extension}`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next index extension.
    }
  }
  return undefined;
}

interface StaticImport {
  readonly specifier: string;
  readonly bindings: readonly string[];
}

function importBindings(clause: string): readonly string[] {
  const bindings: string[] = [];
  const trimmed = clause.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    for (const item of trimmed.slice(1, -1).split(',')) {
      const local = item
        .trim()
        .split(/\s+as\s+/)
        .at(-1);
      if (local !== undefined && /^[A-Za-z_$][\w$]*$/.test(local)) bindings.push(local);
    }
  } else if (trimmed.startsWith('*')) {
    const local = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*)/)?.[1];
    if (local !== undefined) bindings.push(local);
  } else {
    const local = trimmed.split(',')[0]?.trim();
    if (local !== undefined && /^[A-Za-z_$][\w$]*$/.test(local)) bindings.push(local);
  }
  return bindings;
}

function staticImports(source: string): readonly StaticImport[] {
  const imports: StaticImport[] = [];
  const declaration = /\bimport\s+(type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(declaration)) {
    if (match[1] !== undefined) continue;
    const specifier = match[3];
    if (specifier !== undefined && isLocalModule(specifier)) {
      imports.push({ specifier, bindings: importBindings(match[2] ?? '') });
    }
  }
  const sideEffect = /\bimport\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(sideEffect)) {
    const specifier = match[1];
    if (specifier !== undefined && isLocalModule(specifier)) {
      imports.push({ specifier, bindings: [] });
    }
  }
  const exports = /\bexport\s+(?:[^'";]+?\s+from\s+)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(exports)) {
    const specifier = match[1];
    if (specifier !== undefined && isLocalModule(specifier)) {
      imports.push({ specifier, bindings: [] });
    }
  }
  return imports;
}

function literalServices(source: string, property: 'inject' | 'provide'): readonly string[] {
  const services = new Set<string>();
  const pattern = new RegExp(`\\b${property}\\s*:\\s*(?:['"]([^'"]+)['"]|\\[([^\\]]*)\\])`, 'g');
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) services.add(match[1]);
    for (const item of match[2]?.matchAll(/['"]([^'"]+)['"]/g) ?? []) {
      const service = item[1];
      if (service !== undefined) services.add(service);
    }
  }
  return [...services];
}

function manifestServices(inject: GameProjectPluginEntry['inject']): readonly string[] {
  return inject === undefined ? [] : Array.isArray(inject) ? inject : Object.keys(inject);
}

function entryRealm(
  entry: GameProjectPluginEntry,
  inheritedRealm: 'host' | 'engine' | 'build',
): 'host' | 'engine' | 'build' {
  return entry.realm ?? inheritedRealm;
}

async function listPluginFiles(root: string): Promise<readonly string[]> {
  const assetsRoot = resolve(root, 'assets');
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { encoding: 'utf8', withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.forgeax') continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.plugin.ts')) {
        files.push(path);
      }
    }
  }
  await visit(assetsRoot);
  return files;
}

function addDiagnostic<K extends ProjectLintRuleId>(
  diagnostics: ProjectLintDiagnostic[],
  ruleId: K,
  ownerPath: string,
  expected: string,
  hint: string,
  detail: Extract<ProjectLintDiagnostic, { readonly ruleId: K }>['detail'],
): void {
  diagnostics.push({ ruleId, ownerPath, expected, hint, detail } as Extract<
    ProjectLintDiagnostic,
    { readonly ruleId: K }
  >);
}

export async function buildProjectOwnershipGraph(
  facts: ProjectFacts,
): Promise<ProjectOwnershipGraph> {
  const records: ModuleRecord[] = [];
  const diagnostics: ProjectLintDiagnostic[] = [];
  const activeVisits = new Set<string>();
  const activePaths: string[] = [];
  const parsedPaths = new Set<string>();
  const moduleSources = new Map<string, string>();
  const pluginEdges = new Map<string, readonly PluginEdge[]>();

  async function visitModule(
    module: string,
    ownerPath: string,
    realm: 'host' | 'engine' | 'build',
    source: ProjectOwnershipNode['source'],
  ): Promise<void> {
    const path = isLocalModule(module) ? await findLocalModule(facts.root, module) : undefined;
    let sourceText: string | undefined;
    if (path === undefined && isLocalModule(module)) {
      addDiagnostic(
        diagnostics,
        'project-ownership-orphan',
        ownerPath,
        'every static local Plugin import to resolve to one source module',
        'restore the imported module or remove the unreachable ownership edge.',
        { module },
      );
    } else if (path !== undefined) {
      try {
        sourceText = await readFile(path, 'utf8');
      } catch (cause) {
        addDiagnostic(
          diagnostics,
          'project-ownership-orphan',
          ownerPath,
          'each owned module to be readable before lint completes',
          'restore read permission or repair the owning source file.',
          { module, reason: cause instanceof Error ? cause.message : String(cause) },
        );
      }
    }
    records.push({
      module: isLocalModule(module)
        ? relativeModule(facts.root, path ?? resolve(facts.root, module))
        : module,
      ownerPath,
      realm,
      source,
      ...(sourceText === undefined ? {} : { sourceText }),
    });
    if (path === undefined || sourceText === undefined) return;
    const activePathIndex = activePaths.indexOf(path);
    if (activePathIndex !== -1) {
      const modulePath = relativeModule(facts.root, path);
      addDiagnostic(
        diagnostics,
        'project-ownership-cycle',
        ownerPath,
        'the static module graph to be acyclic before ownership projection',
        'break the static import cycle; lint reads source declarations and executes no project code.',
        {
          module: modulePath,
          cycle: [
            ...activePaths.slice(activePathIndex).map((item) => relativeModule(facts.root, item)),
            modulePath,
          ],
        },
      );
      return;
    }
    const visitKey = `${ownerPath}\0${path}`;
    if (activeVisits.has(visitKey)) return;
    if (parsedPaths.has(path)) return;
    activeVisits.add(visitKey);
    parsedPaths.add(path);
    activePaths.push(path);
    const modulePath = relativeModule(facts.root, path);
    moduleSources.set(modulePath, sourceText);
    const imports = staticImports(sourceText);
    const importedPaths = new Map<string, string>();
    for (const imported of imports) {
      const importedPath = await findLocalModule(
        facts.root,
        resolve(dirname(path), imported.specifier),
      );
      const resolvedImport =
        importedPath === undefined ? imported.specifier : relativeModule(facts.root, importedPath);
      importedPaths.set(imported.specifier, resolvedImport);
      await visitModule(
        resolvedImport.startsWith('.') ? resolvedImport : `./${resolvedImport}`,
        `${ownerPath} > ${resolvedImport.replace(/^\.\//, '')}`,
        realm,
        'static-import',
      );
    }
    const bindings = new Map<string, string>();
    for (const imported of imports) {
      for (const binding of imported.bindings) bindings.set(binding, imported.specifier);
    }
    const edges: PluginEdge[] = [];
    for (const match of sourceText.matchAll(/\busePlugin\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
      const binding = match[1];
      if (binding === undefined) continue;
      const specifier = binding === undefined ? undefined : bindings.get(binding);
      const resolvedImport = specifier === undefined ? undefined : importedPaths.get(specifier);
      if (resolvedImport === undefined) continue;
      edges.push({ module: resolvedImport.replace(/^\.\//, ''), binding });
    }
    pluginEdges.set(modulePath, edges);
    activePaths.pop();
    activeVisits.delete(visitKey);
  }

  async function visitEntries(
    entries: readonly GameProjectPluginEntry[],
    parentPath: string,
    inheritedRealm: 'host' | 'engine' | 'build',
  ): Promise<void> {
    for (const entry of entries) {
      const realm = entryRealm(entry, inheritedRealm);
      const ownerPath = `${parentPath}[${entry.id}]`;
      await visitModule(entry.name, ownerPath, realm, 'manifest');
      if (entry.group === true) {
        await visitEntries(
          entry.config as readonly GameProjectPluginEntry[],
          `${ownerPath} > ${entry.name}#children`,
          realm,
        );
      }
    }
  }

  await visitEntries(facts.plugins, 'forge.json#plugins', 'engine');

  const manifestModules = new Set(
    records.filter((record) => record.source === 'manifest').map((record) => record.module),
  );
  const manifestOwnersByModule = new Map<string, string[]>();
  for (const record of records) {
    if (record.source !== 'manifest') continue;
    const owners = manifestOwnersByModule.get(record.module) ?? [];
    owners.push(record.ownerPath);
    manifestOwnersByModule.set(record.module, owners);
  }
  const projectedEdges = new Set<string>();
  const projectedManifestEdges: ModuleRecord[] = [];
  async function projectPluginEdges(
    module: string,
    ownerPath: string,
    realm: 'host' | 'engine' | 'build',
    pathStack: readonly string[],
    scopePath: string,
  ): Promise<void> {
    const cycleIndex = pathStack.indexOf(module);
    if (cycleIndex !== -1) {
      addDiagnostic(
        diagnostics,
        'project-ownership-cycle',
        ownerPath,
        'the Plugin ownership graph to be acyclic before activation',
        'break the usePlugin cycle and keep the static module graph declarative.',
        {
          module,
          cycle: [...pathStack.slice(cycleIndex), module],
        },
      );
      return;
    }
    const nextPathStack = [...pathStack, module];
    for (const edge of pluginEdges.get(module) ?? []) {
      const edgeOwnerPath = `${ownerPath} > usePlugin(${edge.binding}) > ${edge.module}`;
      const projectionKey = `${edgeOwnerPath}\0${edge.module}`;
      if (projectedEdges.has(projectionKey)) continue;
      projectedEdges.add(projectionKey);
      const sourceText = moduleSources.get(edge.module);
      if (sourceText === undefined) continue;
      const edgeRecord: ModuleRecord = {
        module: edge.module,
        ownerPath: edgeOwnerPath,
        realm,
        source: 'plugin-edge',
        sourceText,
      };
      const manifestOwners = manifestOwnersByModule.get(edge.module) ?? [];
      const manifestOwnerPath = manifestOwners[0];
      if (manifestOwnerPath === undefined) {
        records.push(edgeRecord);
        await projectPluginEdges(edge.module, edgeOwnerPath, realm, nextPathStack, scopePath);
        continue;
      }
      projectedManifestEdges.push(edgeRecord);
      await projectPluginEdges(edge.module, edgeOwnerPath, realm, nextPathStack, scopePath);
    }
  }
  for (const record of records) {
    if (record.source !== 'manifest') continue;
    await projectPluginEdges(record.module, record.ownerPath, record.realm, [], record.ownerPath);
  }

  const ownershipByModule = new Map<string, ModuleRecord[]>();
  const executableRecords = records
    .filter((record) => record.source === 'manifest' || record.source === 'plugin-edge')
    .filter((record) => record.source === 'manifest' || !manifestModules.has(record.module));
  for (const record of [...executableRecords, ...projectedManifestEdges]) {
    const owners = ownershipByModule.get(record.module) ?? [];
    owners.push(record);
    ownershipByModule.set(record.module, owners);
  }
  for (const [module, owners] of ownershipByModule) {
    const paths = [...new Set(owners.map((owner) => owner.ownerPath))];
    if (paths.length < 2) continue;
    for (const owner of owners.slice(1)) {
      addDiagnostic(
        diagnostics,
        'project-ownership-multi-owner',
        owner.ownerPath,
        'each executable module to have one ownership path',
        'remove the duplicate Entry or static Group edge and retain one owning Plugin.',
        { module, owners: paths },
      );
    }
  }

  const ownedPluginFiles = new Set(
    executableRecords
      .filter((record) => record.module.endsWith('.plugin.ts'))
      .map((record) => resolve(facts.root, record.module)),
  );
  for (const path of await listPluginFiles(facts.root)) {
    if (ownedPluginFiles.has(path)) continue;
    const module = relativeModule(facts.root, path);
    addDiagnostic(
      diagnostics,
      'project-ownership-orphan',
      module,
      'every *.plugin.ts feature to be reachable from an explicit Entry or Group',
      'import the feature from its owning Plugin Group; lint never activates files by scanning them.',
      { module },
    );
  }

  const providers = new Map<string, ModuleRecord[]>();
  if (
    executableRecords.some((record) => record.realm === 'engine' && record.source === 'manifest')
  ) {
    // A project Entry is reconciled below the App-owned Context. App services
    // are represented once as synthetic provider facts for lint; they never
    // become Catalog or Fiber entries.
    const appOwner: ModuleRecord = {
      module: '@forgeax/engine/app',
      ownerPath: '@forgeax/engine/app',
      realm: 'engine',
      source: 'manifest',
    };
    for (const service of APP_ENGINE_PROVIDERS) providers.set(service, [appOwner]);
  }
  for (const record of executableRecords) {
    for (const service of EXTERNAL_PLUGIN_PROVIDERS.get(record.module) ?? []) {
      const owners = providers.get(service) ?? [];
      owners.push(record);
      providers.set(service, owners);
    }
  }
  const injectors: Array<{ readonly service: string; readonly record: ModuleRecord }> = [];
  for (const record of executableRecords) {
    for (const service of literalServices(record.sourceText ?? '', 'provide')) {
      const owners = providers.get(service) ?? [];
      owners.push(record);
      providers.set(service, owners);
    }
    if (record.module.endsWith('.plugin.ts')) {
      for (const service of literalServices(record.sourceText ?? '', 'inject')) {
        injectors.push({ service, record });
      }
    }
  }
  for (const entry of facts.plugins) {
    for (const service of manifestServices(entry.inject)) {
      const record = records.find(
        (candidate) => candidate.ownerPath === `forge.json#plugins[${entry.id}]`,
      );
      if (record !== undefined) injectors.push({ service, record });
    }
  }
  for (const { service, record } of injectors) {
    if (providers.get(service)?.some((provider) => provider.realm === record.realm) === true)
      continue;
    addDiagnostic(
      diagnostics,
      'project-provider-missing',
      record.ownerPath,
      `an owning Plugin provider for service ${service} to be declared`,
      'declare provide on an owning Plugin in the same realm and rerun the read-only lint.',
      { service, module: record.module, realm: record.realm },
    );
  }

  const ownership = executableRecords.map(({ module, ownerPath, realm, source }) => ({
    module,
    ownerPath,
    realm,
    source,
  }));
  return { ownership, diagnostics };
}
