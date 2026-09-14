import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import type {
  GamePluginEntry,
  PluginCatalog,
  PluginCatalogRecord,
  PluginRealm,
} from '@forgeax/engine-plugin/loader';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    hostAssembly:
      | import('./backend.js').BackendAssemblyAuthority
      | import('./frontend.js').FrontendAssemblyState;
    hostTransport:
      | import('./transport.js').HostTransportServer
      | import('./transport.js').HostTransportClient;
  }
}

/** Wire version for the backend-derived browser assembly. */
export const HOST_ASSEMBLY_SCHEMA_VERSION = 1 as const;

export type HostAssemblySchemaVersion = typeof HOST_ASSEMBLY_SCHEMA_VERSION;

export interface HostModuleDescriptor {
  /** The exact module name used by a Cordis Entry. */
  readonly name: string;
  /** Physical ForgeaX realm expected by the CatalogLoader. */
  readonly realm: PluginRealm;
  /** Code identity. The backend and browser must agree on this value. */
  readonly version: string;
  /** Optional content identity for a static or generated catalog. */
  readonly digest?: string;
  /** URL used by a live browser host. Static builds omit it and use a Catalog. */
  readonly url?: string;
}

/** One package's explicitly paired backend/frontend Entry projections. */
export interface HostPluginPair {
  readonly id: string;
  readonly backend?: HostPluginEndpoint;
  readonly frontend?: HostPluginEndpoint;
}

export interface HostPluginEndpoint {
  readonly entry: GamePluginEntry;
  readonly module: HostModuleDescriptor;
}

/** Safe identity projection; backend Entry configuration never crosses the wire. */
export interface HostAssemblyPair {
  readonly id: string;
  readonly entryId: string;
  readonly module: HostModuleDescriptor;
}

/**
 * A serializable projection of the entries that a frontend may activate.
 * `EntryOptions` is intentionally retained so nested Groups and repeated Entry
 * instances keep native Loader identity and reconciliation semantics.
 */
export interface HostAssembly {
  readonly schemaVersion: HostAssemblySchemaVersion;
  /** Digest of entries, modules and explicitly projected configuration. */
  readonly revision: string;
  readonly entries: readonly GamePluginEntry[];
  readonly modules: readonly HostModuleDescriptor[];
  readonly pairs: readonly HostAssemblyPair[];
  /** Safe, frontend-visible configuration only. */
  readonly config?: unknown;
}

export interface HostAssemblyInput {
  /** Backend Entries are local authority and are never serialized. */
  readonly backendEntries?: readonly GamePluginEntry[];
  readonly entries?: readonly GamePluginEntry[];
  readonly modules?: readonly HostModuleDescriptor[];
  readonly pairs?: readonly HostPluginPair[];
  readonly config?: unknown;
}

export interface HostActivationEntry {
  readonly entryId: string;
  readonly fiberState: string;
  readonly failure?: HostErrorSummary;
}

export interface HostErrorSummary {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface HostActivationReport {
  readonly state: 'created' | 'loading' | 'active' | 'failed' | 'disposed';
  readonly revision: string;
  readonly entries?: readonly HostActivationEntry[];
  readonly error?: HostErrorSummary;
}

export interface HostAssemblyErrorDetailByCode {
  'host-assembly-invalid': { readonly reason: string };
  'host-assembly-revision-mismatch': { readonly actual: string; readonly expected: string };
  'host-assembly-module-missing': { readonly name: string };
  'host-assembly-module-version-mismatch': {
    readonly name: string;
    readonly actual: string;
    readonly expected: string;
  };
  'host-assembly-reload-required': {
    readonly module: string;
    readonly actual: string;
    readonly expected: string;
  };
  'host-assembly-service-unavailable': { readonly service: string };
  'host-assembly-stale-request': { readonly service: string; readonly generation: number };
  'host-assembly-request-aborted': { readonly service: string };
  'host-transport-failure': { readonly service: string; readonly reason: string };
  'host-assembly-not-ready': {
    readonly entryId: string;
    readonly fiberState: string;
    readonly failure?: HostErrorSummary;
  };
}

export type HostAssemblyErrorCode = keyof HostAssemblyErrorDetailByCode;

export class HostAssemblyError<
  C extends HostAssemblyErrorCode = HostAssemblyErrorCode,
> extends Error {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: HostAssemblyErrorDetailByCode[C];

  constructor(code: C, expected: string, hint: string, detail: HostAssemblyErrorDetailByCode[C]) {
    super(`${code}: ${expected}`);
    this.name = 'HostAssemblyError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

/**
 * Prove that the code selected by a local Catalog is the code named by an
 * assembly descriptor. An optional digest is still checked whenever either
 * side supplies one; an unrelated digest must never stand in for a version.
 */
export function assertHostModuleCatalogIdentity(
  module: HostModuleDescriptor,
  record: PluginCatalogRecord,
): void {
  if (record.version !== undefined && record.version !== module.version) {
    throw new HostAssemblyError(
      'host-assembly-module-version-mismatch',
      `module ${module.name} to load catalog version ${module.version}`,
      'Regenerate the static Catalog from the same backend package revision.',
      { name: module.name, actual: record.version, expected: module.version },
    );
  }
  if (
    record.digest !== undefined &&
    module.digest !== undefined &&
    record.digest !== module.digest
  ) {
    throw new HostAssemblyError(
      'host-assembly-module-version-mismatch',
      `module ${module.name} to load catalog digest ${module.digest ?? 'none'}`,
      'Regenerate the static Catalog from the same backend package bytes.',
      { name: module.name, actual: record.digest, expected: module.digest ?? 'none' },
    );
  }
  const versionMatches = record.version !== undefined && record.version === module.version;
  const digestMatches =
    module.digest !== undefined && record.digest !== undefined && record.digest === module.digest;
  const staticWithoutIdentity =
    module.version === 'static' &&
    module.digest === undefined &&
    record.version === undefined &&
    record.digest === undefined;
  if (!versionMatches && !digestMatches && !staticWithoutIdentity) {
    throw new HostAssemblyError(
      'host-assembly-module-version-mismatch',
      `module ${module.name} to have a matching catalog code identity for ${module.version}`,
      'Add the generated module version or digest to the static Catalog.',
      {
        name: module.name,
        actual: record.version ?? record.digest ?? 'unknown',
        expected: module.version,
      },
    );
  }
}

export interface HostAssemblyResult {
  readonly ok: true;
  readonly value: HostAssembly;
}

export interface HostAssemblyFailure {
  readonly ok: false;
  readonly error: HostAssemblyError;
}

export type HostAssemblyValidation = HostAssemblyResult | HostAssemblyFailure;

/** JSON-stable projection used for revision identity and diagnostics. */
export function canonicalHostJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalHostJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalHostJson(item)}`)
    .join(',')}}`;
}

/** Small deterministic digest; it is an identity check, not a security hash. */
export function hostRevision(value: unknown): string {
  let hash = 2166136261;
  for (const char of canonicalHostJson(value)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function cloneEntry(entry: GamePluginEntry): GamePluginEntry {
  const config = entry.group
    ? (entry.config as readonly GamePluginEntry[] | undefined)?.map(cloneEntry)
    : entry.config;
  return {
    id: entry.id,
    name: entry.name,
    ...(config === undefined ? {} : { config }),
    ...(entry.group === undefined ? {} : { group: entry.group }),
    ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
    ...(entry.inject === undefined ? {} : { inject: entry.inject }),
    ...(entry.realm === undefined ? {} : { realm: entry.realm }),
  };
}

function projectPairs(pairs: readonly HostPluginPair[]): {
  readonly entries: readonly GamePluginEntry[];
  readonly modules: readonly HostModuleDescriptor[];
  readonly projections: readonly HostAssemblyPair[];
} {
  const entries: GamePluginEntry[] = [];
  const modules: HostModuleDescriptor[] = [];
  const projections: HostAssemblyPair[] = [];
  for (const pair of pairs) {
    if (
      pair.backend !== undefined &&
      pair.frontend !== undefined &&
      pair.backend.module.version !== pair.frontend.module.version
    ) {
      throw new HostAssemblyError(
        'host-assembly-module-version-mismatch',
        `paired module ${pair.id} to use one code version on both hosts`,
        'Resolve backend and frontend package entries from the same locked package revision.',
        {
          name: pair.id,
          actual: pair.backend.module.version,
          expected: pair.frontend.module.version,
        },
      );
    }
    if (pair.frontend === undefined) continue;
    entries.push(pair.frontend.entry);
    modules.push(pair.frontend.module);
    projections.push({
      id: pair.id,
      entryId: pair.frontend.entry.id,
      module: pair.frontend.module,
    });
  }
  return { entries, modules, projections };
}

function assemblyPairsFromInput(input: HostAssemblyInput): {
  readonly entries: readonly GamePluginEntry[];
  readonly modules: readonly HostModuleDescriptor[];
  readonly pairs: readonly HostAssemblyPair[];
} {
  if (input.pairs !== undefined) {
    const projected = projectPairs(input.pairs);
    return {
      entries: input.entries ?? projected.entries,
      modules: input.modules ?? projected.modules,
      pairs: projected.projections,
    };
  }
  const entries = input.entries ?? [];
  const modules = [...(input.modules ?? [])];
  for (const [index, entry] of entries.entries()) {
    if (modules[index] !== undefined || modules.some((module) => module.name === entry.name))
      continue;
    modules.push({
      name: entry.name,
      realm: entry.realm ?? 'engine',
      version: 'unknown',
    });
  }
  return {
    entries,
    modules,
    pairs: entries.map((entry, index) => ({
      id: entry.id,
      entryId: entry.id,
      module:
        modules[index]?.name === entry.name
          ? modules[index]
          : (modules.find((module) => module.name === entry.name) ?? {
              name: entry.name,
              realm: entry.realm ?? 'engine',
              version: 'unknown',
            }),
    })),
  };
}

/** Build one disposable assembly projection from effective backend inputs. */
export function createHostAssembly(input: HostAssemblyInput): HostAssembly {
  const projected = assemblyPairsFromInput(input);
  const entries = projected.entries.map(cloneEntry);
  const modules = projected.modules.map((module) => ({ ...module }));
  const pairs = projected.pairs.map((pair) => ({ ...pair, module: { ...pair.module } }));
  const identity = {
    schemaVersion: HOST_ASSEMBLY_SCHEMA_VERSION,
    entries,
    modules,
    pairs,
    ...(input.config === undefined ? {} : { config: input.config }),
  };
  return {
    ...identity,
    revision: hostRevision(identity),
  };
}

function validateEntry(entry: EntryOptions, path: string): string | undefined {
  if (entry === null || typeof entry !== 'object') return `${path} must be an Entry object`;
  if (typeof entry.id !== 'string' || entry.id.length === 0) return `${path}.id must be non-empty`;
  if (typeof entry.name !== 'string' || entry.name.length === 0)
    return `${path}.name must be non-empty`;
  if (entry.group === true) {
    if (!Array.isArray(entry.config)) return `${path}.config must be an Entry array for a Group`;
    for (const [index, child] of entry.config.entries()) {
      const reason = validateEntry(child as EntryOptions, `${path}.config[${index}]`);
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}

/** Validate a received assembly before touching the native Loader. */
export function validateHostAssembly(assembly: HostAssembly): HostAssemblyValidation {
  if (assembly === null || typeof assembly !== 'object') {
    return {
      ok: false,
      error: new HostAssemblyError(
        'host-assembly-invalid',
        'assembly to be an object',
        'Regenerate the frontend assembly from the active backend authority.',
        { reason: 'assembly is not an object' },
      ),
    };
  }
  if (assembly.schemaVersion !== HOST_ASSEMBLY_SCHEMA_VERSION) {
    return {
      ok: false,
      error: new HostAssemblyError(
        'host-assembly-invalid',
        `assembly schema ${HOST_ASSEMBLY_SCHEMA_VERSION}`,
        'Regenerate the frontend assembly with the matching Engine host package.',
        { reason: `unsupported schema ${String(assembly.schemaVersion)}` },
      ),
    };
  }
  if (!Array.isArray(assembly.entries) || !Array.isArray(assembly.modules)) {
    return {
      ok: false,
      error: new HostAssemblyError(
        'host-assembly-invalid',
        'assembly entries and modules to be arrays',
        'Regenerate the frontend assembly from the active backend authority.',
        { reason: 'entries or modules is not an array' },
      ),
    };
  }
  if (!Array.isArray(assembly.pairs)) {
    return {
      ok: false,
      error: new HostAssemblyError(
        'host-assembly-invalid',
        'assembly pairs to be an array',
        'Regenerate the assembly from the backend host using the matching host package.',
        { reason: 'pairs is not an array' },
      ),
    };
  }
  const seen = new Set<string>();
  for (const [index, entry] of assembly.entries.entries()) {
    const reason = validateEntry(entry, `entries[${index}]`);
    if (reason !== undefined) {
      return {
        ok: false,
        error: new HostAssemblyError(
          'host-assembly-invalid',
          'all assembly entries to be valid native EntryOptions',
          'Repair the backend Entry projection before publishing it to a browser.',
          { reason },
        ),
      };
    }
    if (seen.has(entry.id)) {
      return {
        ok: false,
        error: new HostAssemblyError(
          'host-assembly-invalid',
          'assembly Entry ids to be unique',
          'Give repeated plugin instances independent stable ids.',
          { reason: `duplicate Entry id ${entry.id}` },
        ),
      };
    }
    seen.add(entry.id);
  }
  const seenModules = new Map<string, HostModuleDescriptor>();
  for (const [index, module] of assembly.modules.entries()) {
    if (
      module === null ||
      typeof module !== 'object' ||
      typeof module.name !== 'string' ||
      typeof module.realm !== 'string' ||
      typeof module.version !== 'string' ||
      module.name.length === 0 ||
      module.version.length === 0 ||
      (module.url !== undefined && typeof module.url !== 'string') ||
      (module.digest !== undefined &&
        (typeof module.digest !== 'string' || module.digest.length === 0))
    ) {
      return {
        ok: false,
        error: new HostAssemblyError(
          'host-assembly-invalid',
          'module names and versions to be non-empty',
          'Regenerate the module projection from the resolved package metadata.',
          { reason: `invalid module at index ${index}` },
        ),
      };
    }
    const previousModule = seenModules.get(module.name);
    if (
      previousModule !== undefined &&
      (previousModule.realm !== module.realm ||
        previousModule.version !== module.version ||
        previousModule.url !== module.url ||
        previousModule.digest !== module.digest)
    ) {
      return {
        ok: false,
        error: new HostAssemblyError(
          'host-assembly-invalid',
          'assembly module identity to be consistent for repeated Entries',
          'Reuse one resolved module identity when a package has multiple Entry instances.',
          { reason: `module ${module.name} has conflicting identities` },
        ),
      };
    }
    seenModules.set(module.name, module);
  }
  const seenPairIds = new Set<string>();
  for (const [index, pair] of assembly.pairs.entries()) {
    const pairModule = pair?.module;
    if (
      pair === null ||
      typeof pair !== 'object' ||
      typeof pair.id !== 'string' ||
      pair.id.length === 0 ||
      typeof pair.entryId !== 'string' ||
      pair.entryId.length === 0 ||
      pairModule === null ||
      pairModule === undefined ||
      typeof pairModule !== 'object' ||
      typeof pairModule.name !== 'string' ||
      typeof pairModule.realm !== 'string' ||
      typeof pairModule.version !== 'string' ||
      pairModule.name.length === 0 ||
      pairModule.version.length === 0 ||
      (pairModule.url !== undefined && typeof pairModule.url !== 'string') ||
      (pairModule.digest !== undefined &&
        (typeof pairModule.digest !== 'string' || pairModule.digest.length === 0))
    ) {
      return {
        ok: false,
        error: new HostAssemblyError(
          'host-assembly-invalid',
          'assembly pair identities and modules to be valid',
          'Regenerate paired frontend entries from the backend package manifest.',
          { reason: `invalid pair at index ${index}` },
        ),
      };
    }
    if (seenPairIds.has(pair.id)) {
      return {
        ok: false,
        error: new HostAssemblyError(
          'host-assembly-invalid',
          'assembly pair ids to be unique',
          'Give each paired package instance an independent stable id.',
          { reason: `duplicate pair ${pair.id}` },
        ),
      };
    }
    seenPairIds.add(pair.id);
    if (!assembly.entries.some((entry) => entry.id === pair.entryId)) {
      return {
        ok: false,
        error: new HostAssemblyError(
          'host-assembly-invalid',
          `pair ${pair.id} to reference an assembly Entry`,
          'Keep paired identity and frontend Entry projection under one backend authority.',
          { reason: `missing frontend Entry ${pair.entryId}` },
        ),
      };
    }
    const module = assembly.modules.find(
      (candidate) =>
        candidate.name === pairModule.name &&
        candidate.realm === pairModule.realm &&
        candidate.version === pairModule.version &&
        candidate.url === pairModule.url &&
        candidate.digest === pairModule.digest,
    );
    if (module === undefined) {
      return {
        ok: false,
        error: new HostAssemblyError(
          'host-assembly-invalid',
          `pair ${pair.id} to reference a resolved frontend module`,
          'Keep module/code identity in the backend-derived assembly projection.',
          { reason: `missing frontend module ${pairModule.name}` },
        ),
      };
    }
  }
  const expected = hostRevision({
    schemaVersion: assembly.schemaVersion,
    entries: assembly.entries,
    modules: assembly.modules,
    pairs: assembly.pairs,
    ...(assembly.config === undefined ? {} : { config: assembly.config }),
  });
  if (expected !== assembly.revision) {
    return {
      ok: false,
      error: new HostAssemblyError(
        'host-assembly-revision-mismatch',
        'assembly revision to match its entries and modules',
        'Discard the stale response and request the current backend assembly again.',
        { actual: assembly.revision, expected },
      ),
    };
  }
  return { ok: true, value: assembly };
}

/** Derive a static module descriptor set from an existing native Catalog. */
export function modulesFromCatalog(
  catalog: PluginCatalog,
  realm: PluginRealm,
  version = 'static',
): HostModuleDescriptor[] {
  return [...catalog.entries()]
    .filter(([, record]) => record.realm === realm)
    .map(([name, record]) => ({
      name,
      realm,
      version: record.version ?? version,
      ...(record.digest === undefined ? {} : { digest: record.digest }),
    }));
}
