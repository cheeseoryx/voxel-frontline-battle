import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PACK_AUTHORING_OPERATION_DESCRIPTORS,
  type PackAuthoringOperation,
  type PackAuthoringOperationResult,
} from '@forgeax/engine-pack/source';
import {
  capabilityUnavailableError,
  createToolRuntime,
  type ToolContribution,
  type ToolDescriptor,
  type ToolRunOptions,
  type ToolRuntime,
  type ToolSchema,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import type {
  BuildOptions,
  PluginConfigureOptions,
  PluginInspectOptions,
  PluginInstallOptions,
  PluginToggleOptions,
  PluginUninstallOptions,
} from '../types.js';
import type { OfflineAnalysisRequest, OfflineAnalysisResult } from './offline-analysis.js';
import { nativePreviewDescriptors } from './preview-catalog.js';
import type { PreviewHostRequest, PreviewHostResult } from './preview-host.js';

export interface ToolCatalogAuthority {
  readonly authorityDigest?: string;
  readonly root?: string;
  readonly read?: () => Promise<ToolCatalogAuthoritySnapshot>;
  readonly projectionPath?: string;
}

export interface ToolCatalogAuthoritySnapshot {
  readonly authorityDigest: string;
  readonly descriptors: readonly ToolDescriptor[];
}

export interface ToolCatalogEntry {
  readonly id: string;
  readonly path: readonly string[];
  readonly title: string;
  readonly summary: string;
  readonly realm: ToolDescriptor['realm'];
  readonly evidence: ToolDescriptor['evidence'];
  readonly argsSchema?: string;
  readonly resultSchema?: string;
}

export interface ToolCatalog {
  readonly schemaVersion: '1.0.0';
  readonly authorityDigest: string;
  readonly digest: string;
  readonly entries: readonly ToolCatalogEntry[];
}

export type ToolCatalogLoadResult =
  | {
      readonly ok: true;
      readonly value: ToolCatalog;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'tool-catalog-authority-unreadable' | 'tool-catalog-projection-invalid';
        readonly expected: string;
        readonly hint: string;
        readonly detail: Readonly<Record<string, string>>;
      };
    };

const buildArgsSchema: ToolSchema<BuildOptions> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected an options object' };
    return { ok: true, value: value as BuildOptions };
  },
  describe:
    '{"type":"object","properties":{"root":{"type":"string"},"base":{"type":"string"},"outDir":{"type":"string"},"json":{"type":"boolean"}}}',
};

const pluginInstallArgsSchema: ToolSchema<PluginInstallOptions> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected a plugin install options object' };
    return { ok: true, value: value as PluginInstallOptions };
  },
  describe:
    '{"type":"object","required":["id","module"],"properties":{"id":{"type":"string"},"module":{"type":"string"},"realm":{"enum":["host","engine","build"]},"dependency":{"type":"string"},"root":{"type":"string"}}}',
};

const pluginInspectArgsSchema: ToolSchema<PluginInspectOptions> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected plugin inspect options object' };
    const id = (value as { readonly id?: unknown }).id;
    if (id !== undefined && typeof id !== 'string')
      return { ok: false, error: 'expected id to be a string when provided' };
    return { ok: true, value: value as PluginInspectOptions };
  },
  describe: '{"type":"object","properties":{"id":{"type":"string"},"root":{"type":"string"}}}',
};

const pluginConfigureArgsSchema: ToolSchema<PluginConfigureOptions> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected plugin configure options object' };
    const candidate = value as { readonly id?: unknown; readonly config?: unknown };
    if (typeof candidate.id !== 'string' || !Object.hasOwn(candidate, 'config'))
      return { ok: false, error: 'expected id and config for plugin configure' };
    return { ok: true, value: value as PluginConfigureOptions };
  },
  describe:
    '{"type":"object","required":["id","config"],"properties":{"id":{"type":"string"},"config":{},"root":{"type":"string"}}}',
};

function pluginToggleArgsSchema<T extends PluginToggleOptions>(): ToolSchema<T> {
  return {
    parse(value) {
      if (value === null || typeof value !== 'object')
        return { ok: false, error: 'expected plugin toggle options object' };
      const id = (value as { readonly id?: unknown }).id;
      if (typeof id !== 'string') return { ok: false, error: 'expected plugin entry id' };
      return { ok: true, value: value as T };
    },
    describe:
      '{"type":"object","required":["id"],"properties":{"id":{"type":"string"},"root":{"type":"string"}}}',
  };
}

const pluginUninstallArgsSchema: ToolSchema<PluginUninstallOptions> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected plugin uninstall options object' };
    const candidate = value as { readonly id?: unknown; readonly dependency?: unknown };
    if (typeof candidate.id !== 'string') return { ok: false, error: 'expected plugin entry id' };
    if (candidate.dependency !== undefined && typeof candidate.dependency !== 'string')
      return { ok: false, error: 'expected dependency to be a string when provided' };
    return { ok: true, value: value as PluginUninstallOptions };
  },
  describe:
    '{"type":"object","required":["id"],"properties":{"id":{"type":"string"},"dependency":{"type":"string"},"root":{"type":"string"}}}',
};

const packAuthoringArgsSchema: ToolSchema<PackAuthoringOperation> = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected a Pack authoring operation object' };
    }
    const operation = value as { readonly requestId?: unknown };
    if (typeof operation.requestId !== 'string' || operation.requestId.trim().length === 0) {
      return { ok: false, error: 'requestId must be a non-empty caller-minted string' };
    }
    return { ok: true, value: value as PackAuthoringOperation };
  },
  describe:
    '{"type":"object","required":["requestId"],"properties":{"requestId":{"type":"string","minLength":1},"expectedRevision":{"type":"string"},"subject":{"type":"string"},"sourcePath":{"type":"string"},"targetPath":{"type":"string"},"packageId":{"type":"string","format":"uuid"},"parentPackageId":{"type":"string","format":"uuid"},"parent":{"type":"string","format":"uuid"},"sourceKey":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$"},"format":{"enum":["pack.ts","pack.json"]},"require":{"enum":["identity","present","ready"]},"values":{"type":"object"},"initialAssets":{"type":"object"},"parameters":{"type":"array","minItems":1}}}',
};

const packAuthoringResultSchema: ToolSchema<PackAuthoringOperationResult> = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected a Pack authoring result object' };
    }
    return { ok: true, value: value as PackAuthoringOperationResult };
  },
  describe: '{"type":"object"}',
};

const operationTitles: Readonly<Record<string, string>> = {
  'asset.list': 'List Pack assets',
  'asset.inspect': 'Inspect Pack subject',
  'asset.resolve': 'Resolve Pack asset identity',
  'asset.verify': 'Verify Pack authoring',
  'asset-source.create': 'Create Pack source',
  'asset-source.clone': 'Clone Pack source',
  'asset-source.create-instance': 'Create Pack instance',
  'asset-source.apply-values': 'Apply Pack instance values',
  'asset-source.rebuild': 'Rebuild Pack source',
  'asset-source.cold-cook': 'Cold-cook Pack source',
};

/** The public command identity is derived from the domain operation id once. */
export function commandPathForToolId(id: string): readonly string[] {
  const authorMatch = /^author\.plugin-(install|inspect|configure|disable|enable|uninstall)$/.exec(
    id,
  );
  if (authorMatch !== null) return ['project', 'plugin', authorMatch[1] as string];
  if (id === 'asset.add') return ['asset', 'import'];
  if (id === 'project.build') return ['project', 'build'];
  if (id === 'preview.offline-analysis') return ['debug', 'preview', 'analyze'];
  if (id === 'preview.run') return ['asset', 'preview'];
  if (id.startsWith('asset-source.')) {
    const operation = id.slice('asset-source.'.length);
    const names: Readonly<Record<string, string>> = {
      'create-instance': 'instance',
      'apply-values': 'set',
      'cold-cook': 'cold-cook',
    };
    return ['asset', names[operation] ?? operation];
  }
  if (id.startsWith('asset.')) return ['asset', id.slice('asset.'.length)];
  if (id.endsWith('.preview')) {
    const kind = id.slice(0, -'.preview'.length);
    return ['asset', kind, 'preview'];
  }
  if (id.startsWith('rhi.')) return ['debug', 'rhi', id.slice('rhi.'.length)];
  if (id.startsWith('profile.')) return ['debug', 'profile', id.slice('profile.'.length)];
  return id.split('.');
}

/** The Pack domain owns these descriptors; DevKit only projects them. */
export const packAuthoringToolDescriptors: readonly ToolDescriptor[] =
  PACK_AUTHORING_OPERATION_DESCRIPTORS.map((operation) => ({
    id: operation.id,
    path: commandPathForToolId(operation.id),
    title: operationTitles[operation.id] ?? operation.id,
    summary: operation.readOnly
      ? 'Reads Pack identity, topology, inheritance, or current readiness without building or writing.'
      : 'Runs the Pack authoring gateway with requestId and revision CAS semantics.',
    realm: 'build' as const,
    argsSchema: packAuthoringArgsSchema,
    resultSchema: packAuthoringResultSchema,
    evidence: [],
  }));

const previewArgsSchema: ToolSchema<PreviewHostRequest> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected a preview request object' };
    const request = value as { readonly recipe?: unknown };
    if (request.recipe === undefined || typeof request.recipe !== 'object')
      return { ok: false, error: 'expected recipe in the preview request' };
    return { ok: true, value: value as PreviewHostRequest };
  },
  describe:
    '{"type":"object","required":["recipe"],"properties":{"recipe":{"type":"object","required":["snapshot"],"properties":{"snapshot":{"type":"object","required":["revision","digest"]},"backend":{"const":"webgpu"},"presentation":{"enum":["hidden","visible"]},"viewport":{"type":"object","properties":{"width":{"type":"integer","minimum":1},"height":{"type":"integer","minimum":1}}},"actions":{"type":"array","items":{"type":"object","required":["frame","name"],"properties":{"frame":{"type":"integer","minimum":0},"name":{"type":"string","minLength":1},"value":{}}}},"deltaSeconds":{"type":"number","minimum":0},"frames":{"type":"integer","minimum":1}}}}}',
};

const resultSchema: ToolSchema<unknown> = {
  parse: (value) => ({ ok: true, value }),
  describe: '{"type":"object"}',
};

const offlineAnalysisArgsSchema: ToolSchema<OfflineAnalysisRequest> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected an offline analysis request object' };
    const request = value as { readonly manifest?: unknown };
    if (request.manifest === undefined || typeof request.manifest !== 'object')
      return { ok: false, error: 'expected manifest in the offline analysis request' };
    return { ok: true, value: value as OfflineAnalysisRequest };
  },
  describe:
    '{"type":"object","required":["manifest"],"properties":{"manifest":{"type":"object","required":["schemaVersion","identity","artifacts"]},"required":{"type":"array","items":{"enum":["rhi-tape","png","profile-capture"]}}}}',
};

export const projectBuildDescriptor: ToolDescriptor<BuildOptions, unknown> = {
  id: 'project.build',
  path: commandPathForToolId('project.build'),
  title: 'Build project',
  summary: 'Builds the project through the existing Vite and Pack authorities.',
  realm: 'build',
  argsSchema: buildArgsSchema,
  resultSchema,
  evidence: [],
};
export const authorPluginInstallDescriptor: ToolDescriptor<PluginInstallOptions, unknown> = {
  id: 'author.plugin-install',
  path: commandPathForToolId('author.plugin-install'),
  title: 'Install project plugin',
  summary: 'Writes one plugin Entry through the project authoring authority.',
  realm: 'build',
  argsSchema: pluginInstallArgsSchema,
  resultSchema,
  evidence: [],
};
export const authorPluginInspectDescriptor: ToolDescriptor<PluginInspectOptions, unknown> = {
  id: 'author.plugin-inspect',
  path: commandPathForToolId('author.plugin-inspect'),
  title: 'Inspect project plugins',
  summary: 'Projects desired Entries beside the real native Fiber tree.',
  realm: 'build',
  argsSchema: pluginInspectArgsSchema,
  resultSchema,
  evidence: [],
};
export const authorPluginConfigureDescriptor: ToolDescriptor<PluginConfigureOptions, unknown> = {
  id: 'author.plugin-configure',
  path: commandPathForToolId('author.plugin-configure'),
  title: 'Configure project plugin',
  summary: 'Validates and atomically updates one plugin Entry config.',
  realm: 'build',
  argsSchema: pluginConfigureArgsSchema,
  resultSchema,
  evidence: [],
};
export const authorPluginDisableDescriptor: ToolDescriptor<PluginToggleOptions, unknown> = {
  id: 'author.plugin-disable',
  path: commandPathForToolId('author.plugin-disable'),
  title: 'Disable project plugin',
  summary: 'Disables one plugin Entry through the authoring transaction.',
  realm: 'build',
  argsSchema: pluginToggleArgsSchema<PluginToggleOptions>(),
  resultSchema,
  evidence: [],
};
export const authorPluginEnableDescriptor: ToolDescriptor<PluginToggleOptions, unknown> = {
  id: 'author.plugin-enable',
  path: commandPathForToolId('author.plugin-enable'),
  title: 'Enable project plugin',
  summary: 'Enables one plugin Entry through the authoring transaction.',
  realm: 'build',
  argsSchema: pluginToggleArgsSchema<PluginToggleOptions>(),
  resultSchema,
  evidence: [],
};
export const authorPluginUninstallDescriptor: ToolDescriptor<PluginUninstallOptions, unknown> = {
  id: 'author.plugin-uninstall',
  path: commandPathForToolId('author.plugin-uninstall'),
  title: 'Uninstall project plugin',
  summary: 'Removes one plugin Entry and its optional dependency atomically.',
  realm: 'build',
  argsSchema: pluginUninstallArgsSchema,
  resultSchema,
  evidence: [],
};
export const previewRunDescriptor: ToolDescriptor<PreviewHostRequest, PreviewHostResult> = {
  id: 'preview.run',
  path: commandPathForToolId('preview.run'),
  title: 'Run hidden WebGPU preview',
  summary: 'Runs one fixed real-WebGPU preview recipe and returns structured evidence refs.',
  realm: 'host',
  argsSchema: previewArgsSchema,
  resultSchema: resultSchema as ToolDescriptor<
    PreviewHostRequest,
    PreviewHostResult
  >['resultSchema'],
  evidence: ['rhi-tape', 'png', 'profile-capture'],
};
export const previewOfflineAnalysisDescriptor: ToolDescriptor<
  OfflineAnalysisRequest,
  OfflineAnalysisResult
> = {
  id: 'preview.offline-analysis',
  path: commandPathForToolId('preview.offline-analysis'),
  title: 'Analyze preview artifacts',
  summary: 'Validates owner-separated evidence identity before offline consumption.',
  realm: 'build',
  argsSchema: offlineAnalysisArgsSchema,
  resultSchema: resultSchema as ToolSchema<OfflineAnalysisResult>,
  evidence: ['rhi-tape', 'png', 'profile-capture'],
};

export const defaultToolDescriptors: readonly ToolDescriptor[] = [
  projectBuildDescriptor,
  authorPluginInstallDescriptor,
  authorPluginInspectDescriptor,
  authorPluginConfigureDescriptor,
  authorPluginDisableDescriptor,
  authorPluginEnableDescriptor,
  authorPluginUninstallDescriptor,
  ...packAuthoringToolDescriptors,
  ...nativePreviewDescriptors,
];

function projectDescriptor(descriptor: ToolDescriptor): ToolCatalogEntry {
  return {
    id: descriptor.id,
    path: descriptor.path ?? commandPathForToolId(descriptor.id),
    title: descriptor.title,
    summary: descriptor.summary,
    realm: descriptor.realm,
    evidence: [...descriptor.evidence],
    ...(descriptor.argsSchema.describe === undefined
      ? {}
      : { argsSchema: descriptor.argsSchema.describe }),
    ...(descriptor.resultSchema.describe === undefined
      ? {}
      : { resultSchema: descriptor.resultSchema.describe }),
  };
}

export interface ToolRealmOwner {
  readonly realm: ToolDescriptor['realm'];
  readonly contributions: readonly ToolContribution[];
}

export interface ToolRealmDispatch {
  readonly list: () => readonly ToolDescriptor[];
  readonly describe: (id: string) => ToolDescriptor | undefined;
  readonly run: <TResult = unknown>(
    id: string,
    args: unknown,
    options?: ToolRunOptions,
  ) => Promise<ToolTerminal<TResult>>;
}

function missingRealmOwner<TResult>(
  descriptor: ToolDescriptor | undefined,
  id: string,
): ToolTerminal<TResult> {
  const realm = descriptor?.realm ?? 'build';
  return {
    outcome: 'failed',
    failure: capabilityUnavailableError(`realm:${realm}:tool:${id}`, realm),
    artifacts: [],
  } as ToolTerminal<TResult>;
}

/** Dispatches a descriptor to the one physical owner for its declared realm. */
export function createRealmDispatch(
  contributions: readonly ToolContribution[],
  owners: readonly ToolRealmOwner[],
): ToolRealmDispatch {
  const contributionById = new Map(
    contributions.map((contribution) => [contribution.descriptor.id, contribution]),
  );
  const ownerByRealm = new Map<ToolDescriptor['realm'], ToolRuntime>();
  for (const owner of owners) {
    if (ownerByRealm.has(owner.realm)) throw new TypeError(`Duplicate realm owner: ${owner.realm}`);
    const invalid = owner.contributions.find(
      (contribution) => contribution.descriptor.realm !== owner.realm,
    );
    if (invalid !== undefined) {
      throw new TypeError(
        `Tool ${invalid.descriptor.id} declares ${invalid.descriptor.realm} but owner is ${owner.realm}`,
      );
    }
    ownerByRealm.set(owner.realm, createToolRuntime(owner.contributions));
  }
  return {
    list: () => contributions.map((contribution) => contribution.descriptor),
    describe: (id) => contributionById.get(id)?.descriptor,
    async run<TResult = unknown>(id: string, args: unknown, options: ToolRunOptions = {}) {
      const contribution = contributionById.get(id);
      if (contribution === undefined)
        return missingRealmOwner(undefined, id) as ToolTerminal<TResult>;
      const owner = ownerByRealm.get(contribution.descriptor.realm);
      if (owner === undefined) return missingRealmOwner(contribution.descriptor, id);
      const bound = owner.get(id);
      if (bound === undefined) return missingRealmOwner(contribution.descriptor, id);
      return (await owner.run(bound, args, options).terminal) as ToolTerminal<TResult>;
    },
  };
}

function requiredAuthorityDigest(authority: ToolCatalogAuthority): string {
  if (authority.authorityDigest === undefined) {
    throw new TypeError('Catalog materialization requires an authority digest');
  }
  return authority.authorityDigest;
}

function digestCatalog(authorityDigest: string, entries: readonly ToolCatalogEntry[]): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ authorityDigest, entries }))
    .digest('hex')}`;
}

function digestAuthority(bytes: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const value of bytes) hash.update(value);
  return `sha256:${hash.digest('hex')}`;
}

function projectionValid(
  catalog: unknown,
  authorityDigest: string,
  descriptors: readonly ToolDescriptor[] = defaultToolDescriptors,
): catalog is ToolCatalog {
  if (catalog === null || typeof catalog !== 'object') return false;
  const value = catalog as Partial<ToolCatalog>;
  const expectedEntries = descriptors
    .map(projectDescriptor)
    .sort((left, right) => left.id.localeCompare(right.id));
  return (
    value.schemaVersion === '1.0.0' &&
    value.authorityDigest === authorityDigest &&
    Array.isArray(value.entries) &&
    JSON.stringify(value.entries) === JSON.stringify(expectedEntries) &&
    value.digest === digestCatalog(authorityDigest, value.entries as ToolCatalogEntry[])
  );
}

export function createProjectToolCatalogAuthority(
  rootInput: string,
  descriptors: readonly ToolDescriptor[] = defaultToolDescriptors,
): ToolCatalogAuthority {
  const root = resolve(rootInput);
  return {
    root,
    projectionPath: resolve(root, '.forgeax/generated/tool-catalog.json'),
    async read() {
      const [forge, packageJson] = await Promise.all([
        readFile(resolve(root, 'forge.json')),
        readFile(resolve(root, 'package.json')),
      ]);
      return { authorityDigest: digestAuthority([forge, packageJson]), descriptors };
    },
  };
}

export async function loadToolCatalog(
  authority: ToolCatalogAuthority,
  descriptors: readonly ToolDescriptor[] = defaultToolDescriptors,
): Promise<ToolCatalogLoadResult> {
  const read = authority.read;
  if (read === undefined) {
    if (authority.authorityDigest === undefined) {
      return {
        ok: false,
        error: {
          code: 'tool-catalog-authority-unreadable',
          expected: 'an injectable project authority reader',
          hint: 'Create a project authority from a real project root before listing tools.',
          detail: { reason: 'authority reader is missing' },
        },
      };
    }
    return { ok: true, value: materializeToolDescriptorCatalog(descriptors, authority) };
  }
  let snapshot: ToolCatalogAuthoritySnapshot;
  try {
    snapshot = await read();
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'tool-catalog-authority-unreadable',
        expected: 'project authority files to be readable',
        hint: 'Repair forge.json and package.json, then retry catalog rebuild.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
  const projectionPath = authority.projectionPath;
  if (projectionPath !== undefined) {
    try {
      const current = JSON.parse(await readFile(projectionPath, 'utf8')) as unknown;
      if (projectionValid(current, snapshot.authorityDigest, snapshot.descriptors)) {
        return { ok: true, value: current };
      }
    } catch {
      // Missing or corrupt projections are rebuilt from the authority below.
    }
  }
  const catalog = materializeToolDescriptorCatalog(snapshot.descriptors, {
    authorityDigest: snapshot.authorityDigest,
  });
  if (projectionPath !== undefined) {
    try {
      await mkdir(resolve(projectionPath, '..'), { recursive: true });
      await writeFile(projectionPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'tool-catalog-projection-invalid',
          expected: 'the generated catalog projection to be writable',
          hint: 'Restore write access to .forgeax/generated and retry cold rebuild.',
          detail: { reason: cause instanceof Error ? cause.message : String(cause) },
        },
      };
    }
  }
  return { ok: true, value: catalog };
}

export function materializeToolCatalog<TArgs, TResult>(
  contributions: readonly ToolContribution<TArgs, TResult>[],
  authority: ToolCatalogAuthority,
): ToolCatalog;
export function materializeToolCatalog(
  contributions: readonly unknown[],
  authority: ToolCatalogAuthority,
): ToolCatalog;
export function materializeToolCatalog(
  contributions: readonly unknown[],
  authority: ToolCatalogAuthority,
): ToolCatalog {
  const entries = contributions
    .map((candidate) => {
      if (typeof candidate !== 'object' || candidate === null)
        throw new TypeError('Invalid tool contribution');
      return projectDescriptor((candidate as ToolContribution<unknown, unknown>).descriptor);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const authorityDigest = requiredAuthorityDigest(authority);
  return {
    schemaVersion: '1.0.0',
    authorityDigest,
    digest: digestCatalog(authorityDigest, entries),
    entries,
  };
}

export function materializeToolDescriptorCatalog(
  descriptors: readonly ToolDescriptor[],
  authority: ToolCatalogAuthority,
): ToolCatalog {
  const entries = descriptors
    .map(projectDescriptor)
    .sort((left, right) => left.id.localeCompare(right.id));
  const authorityDigest = requiredAuthorityDigest(authority);
  return {
    schemaVersion: '1.0.0',
    authorityDigest,
    digest: digestCatalog(authorityDigest, entries),
    entries,
  };
}

export function rebuildToolCatalog<TArgs, TResult>(
  contributions: readonly ToolContribution<TArgs, TResult>[],
  current: ToolCatalog | undefined,
  authority: ToolCatalogAuthority,
): ToolCatalog;
export function rebuildToolCatalog(
  contributions: readonly unknown[],
  current: ToolCatalog | undefined,
  authority: ToolCatalogAuthority,
): ToolCatalog {
  if (
    current !== undefined &&
    authority.authorityDigest !== undefined &&
    current.authorityDigest === authority.authorityDigest &&
    projectionValid(current, authority.authorityDigest)
  )
    return current;
  if (authority.authorityDigest === undefined) {
    throw new TypeError('Catalog rebuild requires an authority digest');
  }
  return materializeToolCatalog(contributions, authority);
}

export function listTools(catalog: ToolCatalog): readonly ToolCatalogEntry[] {
  return catalog.entries;
}

export function describeTool(catalog: ToolCatalog, id: string): ToolCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === id);
}
