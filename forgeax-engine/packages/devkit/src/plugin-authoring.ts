import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { type GameProjectPluginEntry, GameProjectSchema } from '@forgeax/engine-project';
import jiti from 'jiti';
import { execFileCommand } from './child-process.js';
import type { PluginInspectionEntry } from './plugin/inspection.js';
import type { PluginTransaction } from './plugin/transaction.js';
import { deriveRealmCatalogs } from './project/catalog.js';
import type {
  CommandError,
  CommandResult,
  PluginConfigureOptions,
  PluginInspectOptions,
  PluginInstallOptions,
  PluginToggleOptions,
  PluginUninstallOptions,
} from './types.js';

export type {
  PluginEntryTransactionError,
  PluginTransaction,
  PluginTransactionError,
  PluginTransactionErrorCode,
  PluginTransactionInput,
} from './plugin/transaction.js';
export { createPluginTransaction } from './plugin/transaction.js';

type PluginRealm = NonNullable<GameProjectPluginEntry['realm']>;

interface PluginControlOptions {
  /** Optional live transaction supplied by an attached host. */
  readonly transaction?: PluginTransaction;
}

function attachedDependencyFailure(
  operation: 'install' | 'uninstall',
  dependency: string,
): CommandResult<never> {
  return commandFailure(
    'plugin-dependency-transaction-unsupported',
    'an attached PluginTransaction to own the live Fiber and package dependency mutation together',
    'Manage the package dependency before attaching the live realm, or omit --dependency when using an attached transaction; no manifest or Fiber state was changed.',
    { operation, dependency, live: 'last-known-good' },
  );
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function configDigest(value: unknown): string {
  // A deterministic content digest is sufficient for inspection identity. The
  // CLI deliberately avoids a second persisted state store; callers can hash
  // the canonical value with their preferred cryptographic primitive.
  let hash = 2166136261;
  for (const char of canonicalJson(value)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function requiredServices(inject: GameProjectPluginEntry['inject']): readonly string[] {
  if (Array.isArray(inject)) {
    return inject.filter((name): name is string => typeof name === 'string').sort();
  }
  if (inject !== null && typeof inject === 'object') return Object.keys(inject).sort();
  return [];
}

function flattenInspectionEntries(
  entries: readonly GameProjectPluginEntry[],
  liveState: PluginInspectionEntry['fiberState'],
  parent?: string,
  inheritedRealm: PluginRealm = 'engine',
  metadata: ReadonlyMap<
    string,
    { readonly required: readonly string[]; readonly provided: readonly string[] }
  > = new Map(),
): PluginInspectionEntry[] {
  return entries.flatMap((entry) => {
    const realm = entry.realm ?? inheritedRealm;
    const state = entry.disabled === true ? 'disabled' : liveState;
    const current: PluginInspectionEntry = {
      id: entry.id,
      name: entry.name,
      entryId: entry.id,
      module: entry.name,
      realm,
      desiredState: entry.disabled === true ? 'disabled' : 'enabled',
      fiberState: state,
      ...(parent === undefined ? {} : { parent }),
      requiredServices: metadata.get(entry.id)?.required ?? requiredServices(entry.inject),
      providedServices: metadata.get(entry.id)?.provided ?? [],
      configDigest: configDigest(entry.config),
    };
    if (entry.group !== true) return [current];
    return [
      current,
      ...flattenInspectionEntries(
        entry.config as readonly GameProjectPluginEntry[],
        liveState,
        entry.id,
        realm,
        metadata,
      ),
    ];
  });
}

function commandFailure(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): CommandResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

function commandErrorFromUnknown(cause: unknown): CommandError | undefined {
  if (cause === null || typeof cause !== 'object') return undefined;
  if ('ok' in cause && (cause as { readonly ok?: unknown }).ok === false) {
    const nested = (cause as { readonly error?: unknown }).error;
    return commandErrorFromUnknown(nested);
  }
  if ('code' in cause && 'expected' in cause && 'hint' in cause && 'detail' in cause) {
    return cause as CommandError;
  }
  return undefined;
}

function reasonFromUnknown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isStandardSchema(value: unknown): value is {
  readonly '~standard': {
    readonly validate: (value: unknown) => unknown | Promise<unknown>;
  };
} {
  if (value === null || typeof value !== 'object') return false;
  const standard = (value as { readonly '~standard'?: unknown })['~standard'];
  return (
    standard !== null &&
    typeof standard === 'object' &&
    typeof (standard as { readonly validate?: unknown }).validate === 'function'
  );
}

async function resolvePluginModule(root: string, module: string): Promise<string> {
  if (module.startsWith('.') || module.startsWith('/')) {
    const candidate = resolve(root, module);
    const candidates = [
      candidate,
      `${candidate}.ts`,
      `${candidate}.tsx`,
      `${candidate}.js`,
      `${candidate}.mjs`,
      resolve(candidate, 'index.ts'),
      resolve(candidate, 'index.js'),
    ];
    for (const path of candidates) {
      try {
        await access(path);
        return path;
      } catch {
        // Try the next conventional source extension.
      }
    }
    throw new Error(`local plugin module does not resolve: ${module}`);
  }
  // Resolve with the same ESM condition used by the project bundle. The
  // default require condition rejects the umbrella's import-only subpaths
  // (for example @forgeax/engine/physics/rapier3d).
  const requireFromProject = createRequire(resolve(root, 'package.json'));
  const resolveWithConditions = requireFromProject.resolve as unknown as (
    specifier: string,
    options: { readonly conditions: ReadonlySet<string> },
  ) => string;
  return resolveWithConditions(module, {
    conditions: new Set(['node', 'import']),
  });
}

async function preflightPluginModule(
  root: string,
  module: string,
  realm: PluginRealm,
): Promise<{
  readonly resolved: string;
  readonly required: readonly string[];
  readonly provided: readonly string[];
  readonly config?: {
    readonly '~standard': {
      readonly validate: (value: unknown) => unknown | Promise<unknown>;
    };
  };
}> {
  let resolved: string;
  try {
    resolved = await resolvePluginModule(root, module);
  } catch (cause) {
    throw commandFailure(
      'plugin-module-missing',
      'the candidate plugin module to resolve from the project root',
      'Restore the module, install its dependency, or update the Entry name before committing forge.json.',
      { module, realm, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  try {
    // Keep published ESM packages on native import conditions. Jiti's
    // transpilation path falls back to require for nested dependencies and
    // would reject an import-only subpath in an umbrella facade. Local TS
    // author modules still use Jiti because Node cannot execute them directly.
    const namespace =
      extname(resolved) === '.ts' || extname(resolved) === '.tsx'
        ? await jiti(import.meta.url, { interopDefault: false, esmResolve: true }).import(
            resolved,
            {
              _import: () => import(resolved),
            },
          )
        : await import(resolved);
    const value =
      namespace !== null && typeof namespace === 'object' && 'default' in namespace
        ? (namespace as { readonly default?: unknown }).default
        : namespace;
    const plugin =
      value !== null && typeof value === 'object' && 'plugin' in value
        ? (value as { readonly plugin?: unknown }).plugin
        : value;
    const isPlugin =
      typeof plugin === 'function' ||
      (plugin !== null &&
        typeof plugin === 'object' &&
        typeof (plugin as { apply?: unknown }).apply === 'function');
    if (!isPlugin) {
      throw new Error('module must export a native Cordis Plugin (or ToolPlugin)');
    }
    const metadata = plugin as {
      readonly inject?: string[] | Record<string, unknown>;
      readonly provide?: string | string[];
      readonly Config?: unknown;
    };
    if (metadata.Config !== undefined && !isStandardSchema(metadata.Config)) {
      throw new Error('Plugin.Config must implement the Standard Schema validate contract');
    }
    return {
      resolved,
      required: requiredServices(metadata.inject),
      provided:
        metadata.provide === undefined
          ? []
          : Array.isArray(metadata.provide)
            ? [...metadata.provide]
            : [metadata.provide],
      ...(metadata.Config === undefined ? {} : { config: metadata.Config }),
    };
  } catch (cause) {
    // A project Group may import the Vite-owned asset virtual module. The
    // Node control plane cannot execute that bundler-only module, but it can
    // still validate the Group's native shape without inventing a runtime
    // registry or treating the virtual module as an install dependency.
    if (module.startsWith('.') && reasonFromUnknown(cause).includes('virtual:forgeax/assets')) {
      try {
        const source = await readFile(resolved, 'utf8');
        if (source.includes('definePluginGroup')) {
          return { resolved, required: [], provided: [] };
        }
      } catch {
        // Preserve the structured module-invalid error below when the source
        // itself is no longer readable.
      }
    }
    throw commandFailure(
      'plugin-module-invalid',
      'the candidate module to evaluate to a native Cordis Plugin',
      'Export a default Plugin object/function (or ToolPlugin) and repair its imports before retrying.',
      {
        module,
        realm,
        path: resolved,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
}

async function preflightEntries(
  root: string,
  entries: readonly GameProjectPluginEntry[],
): Promise<
  ReadonlyMap<
    string,
    { readonly required: readonly string[]; readonly provided: readonly string[] }
  >
> {
  try {
    deriveRealmCatalogs(entries);
  } catch (cause) {
    throw commandFailure(
      'plugin-candidate-invalid',
      'the candidate EntryTree to have one module and realm ownership path',
      'Split entries by realm or remove duplicate module registrations before retrying.',
      { reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  const metadata = new Map<
    string,
    { readonly required: readonly string[]; readonly provided: readonly string[] }
  >();
  const candidates = flattenEntries(entries, 'engine');
  for (const { entry, realm } of candidates) {
    if (entry.name.startsWith('cordis:')) continue;
    const result = await preflightPluginModule(root, entry.name, realm);
    if (result.config !== undefined) {
      let validation: unknown;
      try {
        validation = await result.config['~standard'].validate(entry.config);
      } catch (cause) {
        throw commandFailure(
          'plugin-config-invalid',
          `${entry.name} Plugin.Config to validate the Entry config`,
          'Repair the Entry config using the plugin schema before writing forge.json or activating a Fiber.',
          { id: entry.id, module: entry.name, realm, reason: reasonFromUnknown(cause) },
        );
      }
      if (
        validation !== null &&
        typeof validation === 'object' &&
        'issues' in validation &&
        (validation as { readonly issues?: unknown }).issues
      ) {
        throw commandFailure(
          'plugin-config-invalid',
          `${entry.name} Plugin.Config to validate the Entry config`,
          'Repair the Entry config using the plugin schema before writing forge.json or activating a Fiber.',
          {
            id: entry.id,
            module: entry.name,
            realm,
            issues: (validation as { readonly issues: unknown }).issues,
          },
        );
      }
    }
    metadata.set(entry.id, { required: result.required, provided: result.provided });
  }
  return metadata;
}

function flattenEntries(
  entries: readonly GameProjectPluginEntry[],
  inheritedRealm: PluginRealm,
): readonly { readonly entry: GameProjectPluginEntry; readonly realm: PluginRealm }[] {
  return entries.flatMap((entry) => {
    const realm = entry.realm ?? inheritedRealm;
    return [
      { entry, realm },
      ...(entry.group === true
        ? flattenEntries(entry.config as readonly GameProjectPluginEntry[], realm)
        : []),
    ];
  });
}

async function readManifest(root: string): Promise<CommandResult<{ raw: string; value: unknown }>> {
  const path = resolve(root, 'forge.json');
  try {
    const raw = await readFile(path, 'utf8');
    return { ok: true, value: { raw, value: JSON.parse(raw) as unknown } };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'plugin-manifest-unreadable',
        expected: 'a readable forge.json',
        hint: 'Repair the project manifest before changing plugin installation state.',
        detail: { path, reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
}

async function writeManifest(root: string, value: unknown): Promise<void> {
  const path = resolve(root, 'forge.json');
  const temporary = resolve(root, `.forgeax-plugin-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

function allEntries(entries: readonly GameProjectPluginEntry[]): GameProjectPluginEntry[] {
  return entries.flatMap((entry) => [
    entry,
    ...(entry.group === true ? allEntries(entry.config as readonly GameProjectPluginEntry[]) : []),
  ]);
}

function withoutEntry(
  entries: readonly GameProjectPluginEntry[],
  id: string,
): GameProjectPluginEntry[] {
  return entries.flatMap((entry) => {
    if (entry.id === id) return [];
    if (entry.group !== true) return [entry];
    return [
      {
        ...entry,
        config: withoutEntry(entry.config as readonly GameProjectPluginEntry[], id),
      },
    ];
  });
}

async function mutateDependency(
  root: string,
  action: 'add' | 'remove',
  dependency: string | undefined,
): Promise<void> {
  if (dependency === undefined) return;
  await execFileCommand('pnpm', [action, dependency], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function parsedManifest(root: string): Promise<
  | {
      readonly ok: true;
      readonly value: ReturnType<typeof GameProjectSchema.parse>;
      readonly raw: string;
    }
  | { readonly ok: false; readonly error: import('./types.js').CommandError }
> {
  const manifest = await readManifest(root);
  if (!manifest.ok) return { ok: false, error: manifest.error };
  const parsed = GameProjectSchema.safeParse(manifest.value.value);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'plugin-manifest-invalid',
        expected: 'forge.json to satisfy GameProjectSchema',
        hint: 'Repair the manifest before changing plugin installation state.',
        detail: { issues: parsed.error.issues },
      },
    };
  }
  return { ok: true, value: parsed.data, raw: manifest.value.raw };
}

function findEntry(
  entries: readonly GameProjectPluginEntry[],
  id: string,
): GameProjectPluginEntry | undefined {
  for (const entry of entries) {
    if (entry.id === id) return entry;
    if (entry.group === true) {
      const found = findEntry(entry.config as readonly GameProjectPluginEntry[], id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function staticMutation(
  root: string,
  id: string,
  operation: 'configure' | 'disable' | 'enable' | 'uninstall',
  edit: (
    project: ReturnType<typeof GameProjectSchema.parse>,
  ) => ReturnType<typeof GameProjectSchema.parse>,
  dryRun: boolean,
): Promise<CommandResult<unknown>> {
  const manifest = await parsedManifest(root);
  if (!manifest.ok) return manifest;
  const entries = manifest.value.plugins ?? [];
  if (findEntry(entries, id) === undefined) {
    return commandFailure(
      'plugin-entry-missing',
      'the requested plugin Entry id to exist in forge.json#plugins[]',
      'Run forgeax project plugin inspect --json and pass an installed Entry id.',
      { id, operation },
    );
  }
  const next = edit(manifest.value);
  if (operation !== 'uninstall') {
    try {
      await preflightEntries(root, next.plugins ?? []);
    } catch (cause) {
      const commandError = commandErrorFromUnknown(cause);
      if (commandError !== undefined) return { ok: false, error: commandError };
      return commandFailure(
        'plugin-candidate-invalid',
        'the candidate EntryTree to pass module preflight',
        'Repair the candidate module and retry without changing the current manifest.',
        { reason: reasonFromUnknown(cause) },
      );
    }
  }
  if (dryRun) {
    return {
      ok: true,
      value: { root, id, operation, manifest: next, liveState: 'unavailable' },
    };
  }
  try {
    await writeManifest(root, next);
    return { ok: true, value: { root, id, operation, liveState: 'unavailable' } };
  } catch (cause) {
    return commandFailure(
      `plugin-${operation}-failed`,
      'the candidate manifest to replace forge.json atomically',
      'The author manifest was not committed; inspect the filesystem diagnostic and retry.',
      { id, operation, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

export async function pluginInspectCommand(
  options: PluginInspectOptions & PluginControlOptions,
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd());
  if (options.transaction !== undefined) {
    try {
      const inspection = await options.transaction.inspect();
      return {
        ok: true,
        value: { root, ...inspection, liveState: 'attached' },
      };
    } catch (cause) {
      const commandError = commandErrorFromUnknown(cause);
      if (commandError !== undefined) return { ok: false, error: commandError };
      return commandFailure(
        'plugin-inspect-failed',
        'the connected Plugin Loader to provide a projection',
        'Reconnect the live realm and retry; inspect the last-known-good Fiber state.',
        { reason: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }
  const manifest = await parsedManifest(root);
  if (!manifest.ok) return manifest;
  let metadata: ReadonlyMap<
    string,
    { readonly required: readonly string[]; readonly provided: readonly string[] }
  >;
  try {
    metadata = await preflightEntries(root, manifest.value.plugins ?? []);
  } catch (cause) {
    const commandError = commandErrorFromUnknown(cause);
    if (commandError !== undefined) return { ok: false, error: commandError };
    return commandFailure(
      'plugin-inspect-failed',
      'the project EntryTree to pass module and config inspection',
      'Repair the owning module or Entry config, then retry inspection.',
      { reason: reasonFromUnknown(cause) },
    );
  }
  const all = flattenInspectionEntries(
    manifest.value.plugins ?? [],
    'unavailable',
    undefined,
    'engine',
    metadata,
  );
  const entries =
    options.id === undefined ? all : all.filter((entry) => entry.entryId === options.id);
  if (options.id !== undefined && entries.length === 0) {
    return commandFailure(
      'plugin-entry-missing',
      'the requested plugin Entry id to exist in forge.json#plugins[]',
      'Pass an installed Entry id or omit the id to inspect the complete project tree.',
      { id: options.id },
    );
  }
  const copyEntries = (source: readonly PluginInspectionEntry[]): PluginInspectionEntry[] =>
    source.map((entry) => ({
      ...entry,
      ...(entry.parent === undefined ? {} : { parent: entry.parent }),
      requiredServices: [...entry.requiredServices],
      providedServices: [...entry.providedServices],
    }));
  return {
    ok: true,
    value: {
      root,
      liveState: 'unavailable',
      desired: copyEntries(entries),
      live: [],
      entries: copyEntries(entries),
    },
  };
}

export function pluginConfigureCommand(
  options: PluginConfigureOptions & PluginControlOptions,
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd());
  if (options.transaction !== undefined) {
    return options.transaction
      .configure(options.id, options.config)
      .then(() => ({
        ok: true as const,
        value: { root, id: options.id, operation: 'configure', liveState: 'attached' },
      }))
      .catch((cause) => {
        const commandError = commandErrorFromUnknown(cause);
        if (commandError !== undefined) return { ok: false, error: commandError };
        return commandFailure(
          'plugin-configure-failed',
          'the connected Plugin Loader and manifest to commit together',
          'Repair the candidate config; the live Loader keeps its last-known-good Fiber.',
          { id: options.id, reason: reasonFromUnknown(cause) },
        );
      });
  }
  return staticMutation(
    root,
    options.id,
    'configure',
    (project) => ({
      ...project,
      plugins: project.plugins.map((entry) =>
        updateEntryInTree(entry, options.id, (value) => ({ ...value, config: options.config })),
      ),
    }),
    options.dryRun === true,
  );
}

export function pluginDisableCommand(
  options: PluginToggleOptions & PluginControlOptions,
): Promise<CommandResult<unknown>> {
  return togglePluginCommand(options, 'disable');
}

export function pluginEnableCommand(
  options: PluginToggleOptions & PluginControlOptions,
): Promise<CommandResult<unknown>> {
  return togglePluginCommand(options, 'enable');
}

function togglePluginCommand(
  options: PluginToggleOptions & PluginControlOptions,
  operation: 'disable' | 'enable',
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd());
  if (options.transaction !== undefined) {
    const action =
      operation === 'disable' ? options.transaction.disable : options.transaction.enable;
    return action(options.id)
      .then(() => ({
        ok: true as const,
        value: { root, id: options.id, operation, liveState: 'attached' },
      }))
      .catch((cause) => {
        const commandError = commandErrorFromUnknown(cause);
        if (commandError !== undefined) return { ok: false, error: commandError };
        return commandFailure(
          `plugin-${operation}-failed`,
          'the connected Plugin Loader and manifest to commit together',
          'Repair the Entry or reconnect the live realm; the current Fiber remains last-known-good.',
          { id: options.id, reason: reasonFromUnknown(cause) },
        );
      });
  }
  return staticMutation(
    root,
    options.id,
    operation,
    (project) => ({
      ...project,
      plugins: project.plugins.map((entry) =>
        updateEntryInTree(entry, options.id, (value) => ({
          ...value,
          disabled: operation === 'disable',
        })),
      ),
    }),
    options.dryRun === true,
  );
}

function updateEntryInTree(
  entry: GameProjectPluginEntry,
  id: string,
  update: (entry: GameProjectPluginEntry) => GameProjectPluginEntry,
): GameProjectPluginEntry {
  if (entry.id === id) return update(entry);
  if (entry.group !== true) return entry;
  return {
    ...entry,
    config: (entry.config as readonly GameProjectPluginEntry[]).map((child) =>
      updateEntryInTree(child, id, update),
    ),
  };
}

export async function pluginInstallCommand(
  options: PluginInstallOptions & PluginControlOptions,
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd());
  if (options.transaction !== undefined && options.dependency !== undefined) {
    return attachedDependencyFailure('install', options.dependency);
  }
  const manifest = await parsedManifest(root);
  if (!manifest.ok) return manifest;
  const entries = manifest.value.plugins ?? [];
  if (allEntries(entries).some((entry) => entry.id === options.id)) {
    return commandFailure(
      'plugin-entry-id-conflict',
      'a project-unique plugin Entry id',
      'Choose a stable id not already present in forge.json#plugins[].',
      { id: options.id },
    );
  }
  const next = {
    ...manifest.value,
    plugins: [
      ...entries,
      { id: options.id, name: options.module, realm: options.realm ?? 'engine' },
    ],
  };
  try {
    // The static preflight is the offline half of the same transaction. A
    // connected host may provide a live transaction below, but the CLI never
    // claims a Fiber exists when it cannot observe one.
    await preflightEntries(root, next.plugins);
  } catch (cause) {
    const commandError = commandErrorFromUnknown(cause);
    if (commandError !== undefined) return { ok: false, error: commandError };
    return commandFailure(
      'plugin-candidate-invalid',
      'the candidate EntryTree to pass module preflight',
      'Repair the candidate module and retry without changing the current manifest.',
      { id: options.id, reason: reasonFromUnknown(cause) },
    );
  }
  if (options.dryRun === true) {
    return { ok: true, value: { root, manifest: next, liveState: 'unavailable' } };
  }
  if (options.transaction !== undefined && options.dependency === undefined) {
    try {
      await options.transaction.install({
        id: options.id,
        name: options.module,
        realm: options.realm ?? 'engine',
      });
      return {
        ok: true,
        value: { root, id: options.id, module: options.module, liveState: 'attached' },
      };
    } catch (cause) {
      const commandError = commandErrorFromUnknown(cause);
      if (commandError !== undefined) return { ok: false, error: commandError };
      return commandFailure(
        'plugin-install-failed',
        'the candidate EntryTree and connected Plugin Loader to commit together',
        'Repair the candidate Plugin or reconnect the live realm; its previous Fiber remains last-known-good.',
        { id: options.id, reason: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }
  try {
    await writeManifest(root, next);
    await mutateDependency(root, 'add', options.dependency);
    return {
      ok: true,
      value: { root, id: options.id, module: options.module, liveState: 'unavailable' },
    };
  } catch (cause) {
    await writeFile(resolve(root, 'forge.json'), manifest.raw);
    return {
      ok: false,
      error: {
        code: 'plugin-install-failed',
        expected: 'dependency and forge.json Entry mutations to commit together',
        hint: 'Inspect the package-manager failure; the original forge.json was restored.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
}

export async function pluginUninstallCommand(
  options: PluginUninstallOptions & PluginControlOptions,
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd());
  if (options.transaction !== undefined && options.dependency !== undefined) {
    return attachedDependencyFailure('uninstall', options.dependency);
  }
  const manifest = await parsedManifest(root);
  if (!manifest.ok) return manifest;
  const entries = manifest.value.plugins ?? [];
  if (!allEntries(entries).some((entry) => entry.id === options.id)) {
    return commandFailure(
      'plugin-entry-missing',
      'the plugin Entry id to exist',
      'Inspect forge.json#plugins[] and pass an installed Entry id.',
      { id: options.id },
    );
  }
  if (options.transaction !== undefined) {
    try {
      await options.transaction.uninstall(options.id);
      return { ok: true, value: { root, id: options.id, liveState: 'attached' } };
    } catch (cause) {
      const commandError = commandErrorFromUnknown(cause);
      if (commandError !== undefined) return { ok: false, error: commandError };
      return commandFailure(
        'plugin-uninstall-failed',
        'the connected Plugin Loader and manifest to commit together',
        'Reconnect the live realm; the current Fiber remains last-known-good.',
        { id: options.id, reason: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }
  const next = { ...manifest.value, plugins: withoutEntry(entries, options.id) };
  if (options.dryRun === true) {
    return { ok: true, value: { root, id: options.id, manifest: next, liveState: 'unavailable' } };
  }
  try {
    await writeManifest(root, next);
    await mutateDependency(root, 'remove', options.dependency);
    return { ok: true, value: { root, id: options.id, liveState: 'unavailable' } };
  } catch (cause) {
    await writeFile(resolve(root, 'forge.json'), manifest.raw);
    return {
      ok: false,
      error: {
        code: 'plugin-uninstall-failed',
        expected: 'Entry and dependency removal to commit together',
        hint: 'Inspect the package-manager failure; the original forge.json was restored.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
}
