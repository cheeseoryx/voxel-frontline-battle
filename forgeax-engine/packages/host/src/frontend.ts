import { Context, type Fiber, inspectCatalogPlugins, type Plugin } from '@forgeax/engine-plugin';
import {
  type CatalogLoader,
  type GamePluginEntry,
  installCatalogLoader,
  type PluginCatalog,
  type PluginCatalogRecord,
  type PluginRealm,
  projectPluginEntries,
} from '@forgeax/engine-plugin/loader';
import {
  assertHostModuleCatalogIdentity,
  createHostAssembly,
  type HostActivationEntry,
  type HostActivationReport,
  type HostAssembly,
  HostAssemblyError,
  type HostErrorSummary,
  modulesFromCatalog,
  validateHostAssembly,
} from './protocol.js';
import { createHostStartup, type HostStartup } from './startup.js';
import {
  HOST_ACTIVATION_REPORT_SERVICE,
  HOST_ASSEMBLY_SERVICE,
  type HostTransportClient,
} from './transport.js';

export type FrontendHostState = 'created' | 'loading' | 'active' | 'failed' | 'disposed';

export interface FrontendHostStatus {
  readonly state: FrontendHostState;
  readonly revision: string;
  readonly entries?: readonly HostActivationEntry[];
  readonly error?: unknown;
}

export interface FrontendAssemblyState {
  readonly current: HostAssembly;
  readonly status: FrontendHostStatus;
}

export interface FrontendHostOptions {
  /** App may provide its existing Engine Context; the host owns only its Fiber. */
  readonly context?: Context;
  readonly startupPlugins?: readonly Plugin[];
  readonly catalog?: PluginCatalog;
  /**
   * Optional local assembly snapshot used for the first staged activation.
   * When a transport is also present, the backend remains authoritative for
   * later updates; this snapshot lets callers activate provider-only entries
   * before their host-owned services are ready.
   */
  readonly assembly?: HostAssembly;
  readonly entries?: readonly GamePluginEntry[];
  readonly realm?: PluginRealm;
  readonly config?: unknown;
  readonly transport?: HostTransportClient;
  readonly moduleVersions?: ReadonlyMap<string, string>;
  readonly reportStatus?: (status: FrontendHostStatus) => void | Promise<void>;
  readonly autoActivate?: boolean;
}

export interface FrontendHost {
  readonly context: Context;
  readonly loader?: CatalogLoader;
  readonly assembly: FrontendAssemblyState;
  readonly transport?: HostTransportClient;
  readonly ownedContext: boolean;
  readonly status: FrontendHostStatus;
  activate(assembly?: HostAssembly): Promise<void>;
  update(assembly: HostAssembly): Promise<void>;
  dispose(): Promise<void>;
}

function hostFoundationPlugin(
  assembly: FrontendAssemblyState,
  transport: HostTransportClient | undefined,
): Plugin {
  return {
    name: 'forgeax:frontend-host-foundation',
    provide: ['hostAssembly', 'hostTransport'],
    apply(ctx) {
      ctx.provide('hostAssembly', assembly);
      if (transport !== undefined) ctx.provide('hostTransport', transport);
    },
  };
}

function dynamicModuleRecord(
  name: string,
  realm: PluginRealm,
  version: string,
  url: string | undefined,
  digest: string | undefined,
): PluginCatalogRecord {
  if (url === undefined) {
    return {
      realm,
      version,
      ...(digest === undefined ? {} : { digest }),
      load: async () => {
        throw new HostAssemblyError(
          'host-assembly-module-missing',
          `module ${name} to have a browser URL or static Catalog record`,
          'Add the module to the frozen Catalog or publish its browser entry from the backend.',
          { name },
        );
      },
    };
  }
  return {
    realm,
    version,
    ...(digest === undefined ? {} : { digest }),
    load: () => import(/* @vite-ignore */ url),
  };
}

function catalogForAssembly(
  assembly: HostAssembly,
  staticCatalog: PluginCatalog | undefined,
): PluginCatalog {
  const catalog = new Map<string, PluginCatalogRecord>();
  for (const module of assembly.modules) {
    const existing = staticCatalog?.get(module.name);
    if (existing !== undefined) {
      assertHostModuleCatalogIdentity(module, existing);
      catalog.set(module.name, existing);
      continue;
    }
    catalog.set(
      module.name,
      dynamicModuleRecord(module.name, module.realm, module.version, module.url, module.digest),
    );
  }
  for (const [name, record] of staticCatalog ?? []) {
    if (!catalog.has(name)) catalog.set(name, record);
  }
  return catalog;
}

function assertModuleVersions(
  assembly: HostAssembly,
  versions: ReadonlyMap<string, string> | undefined,
): void {
  if (versions === undefined) return;
  for (const module of assembly.modules) {
    const actual = versions.get(module.name);
    if (actual === undefined || actual === module.version) continue;
    throw new HostAssemblyError(
      'host-assembly-module-version-mismatch',
      `module ${module.name} to use version ${module.version}`,
      'Refresh the browser module graph from the same backend assembly revision.',
      { name: module.name, actual, expected: module.version },
    );
  }
}

function moduleIdentity(module: {
  readonly version: string;
  readonly digest?: string;
  readonly url?: string;
}): string {
  return `${module.version}@${module.digest ?? module.url ?? '<catalog>'}`;
}

/**
 * The native Loader keeps the imported module graph for its lifetime. A new
 * module URL or code identity therefore cannot be applied by Entry.update;
 * accepting it would report a new assembly while executing the old code.
 */
function assertModuleReloadBoundary(previous: HostAssembly, next: HostAssembly): void {
  const previousModules = new Map(previous.modules.map((module) => [module.name, module]));
  const nextModules = new Map(next.modules.map((module) => [module.name, module]));
  const names = new Set([...previousModules.keys(), ...nextModules.keys()]);
  for (const name of names) {
    const before = previousModules.get(name);
    const after = nextModules.get(name);
    const beforeIdentity = before === undefined ? '<absent>' : moduleIdentity(before);
    const afterIdentity = after === undefined ? '<absent>' : moduleIdentity(after);
    if (
      before === undefined ||
      after === undefined ||
      before.realm !== after.realm ||
      beforeIdentity !== afterIdentity
    ) {
      throw new HostAssemblyError(
        'host-assembly-reload-required',
        `module ${name} to keep its loaded code identity ${beforeIdentity}`,
        'Reload the frontend host to install the new module graph before activating this assembly.',
        { module: name, actual: beforeIdentity, expected: afterIdentity },
      );
    }
  }
}

function staticAssembly(options: FrontendHostOptions, realm: PluginRealm): HostAssembly {
  const entries = options.entries ?? [];
  const modules =
    options.catalog === undefined ? [] : modulesFromCatalog(options.catalog, realm, 'static');
  return createHostAssembly({
    entries,
    modules,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
}

function errorSummary(error: unknown): HostErrorSummary | undefined {
  if (
    error === null ||
    typeof error !== 'object' ||
    typeof (error as { code?: unknown }).code !== 'string' ||
    typeof (error as { expected?: unknown }).expected !== 'string' ||
    typeof (error as { hint?: unknown }).hint !== 'string'
  )
    return undefined;
  const detail = (error as { readonly detail?: unknown }).detail;
  return {
    code: (error as { readonly code: string }).code,
    expected: (error as { readonly expected: string }).expected,
    hint: (error as { readonly hint: string }).hint,
    detail:
      detail !== null && typeof detail === 'object'
        ? (detail as Readonly<Record<string, unknown>>)
        : { reason: String(detail ?? 'unknown failure') },
  };
}

async function fetchInitialAssembly(
  options: FrontendHostOptions,
  realm: PluginRealm,
): Promise<HostAssembly> {
  // An explicit assembly is an intentional bootstrap snapshot.  DevKit uses
  // it to stage provider-only entries on reconnect before installing the
  // GameHost service; the transport still supplies the authoritative full
  // assembly immediately afterwards.
  if (options.assembly !== undefined) return options.assembly;
  if (options.transport !== undefined)
    return options.transport.request<undefined, HostAssembly>(HOST_ASSEMBLY_SERVICE, undefined);
  if (
    options.entries !== undefined ||
    options.catalog !== undefined ||
    options.config !== undefined
  )
    return staticAssembly(options, realm);
  throw new HostAssemblyError(
    'host-assembly-service-unavailable',
    'a static assembly or backend transport to be provided',
    'Pass the frozen assembly for a static player or connect the frontend host to a backend host.',
    { service: HOST_ASSEMBLY_SERVICE },
  );
}

function readiness(loader: CatalogLoader): readonly HostActivationEntry[] {
  return inspectCatalogPlugins(loader).live.map((entry) => ({
    entryId: entry.entryId,
    fiberState: entry.fiberState,
    ...(entry.failure === undefined
      ? {}
      : {
          failure: {
            code: entry.failure.code,
            expected: entry.failure.expected,
            hint: entry.failure.hint,
            detail: entry.failure.detail,
          },
        }),
  }));
}

function assertReady(entries: readonly HostActivationEntry[]): void {
  const failed = entries.find(
    (entry) => entry.fiberState !== 'active' && entry.fiberState !== 'disabled',
  );
  if (failed === undefined) return;
  throw new HostAssemblyError(
    'host-assembly-not-ready',
    `Entry ${failed.entryId} to reach active or disabled Fiber state`,
    'Inspect the Entry failure or waiting dependency and repair the frontend package graph.',
    {
      entryId: failed.entryId,
      fiberState: failed.fiberState,
      ...(failed.failure === undefined ? {} : { failure: failed.failure }),
    },
  );
}

/** Start one independent browser-side manager and its native Cordis Loader. */
export async function createFrontendHost(options: FrontendHostOptions = {}): Promise<FrontendHost> {
  const realm = options.realm ?? 'engine';
  const initial = await fetchInitialAssembly(options, realm);
  const context = options.context ?? new Context();
  const ownedContext = options.context === undefined;
  const checked = validateHostAssembly(initial);
  if (!checked.ok) throw checked.error;
  let current = checked.value;
  let status: FrontendHostStatus = {
    state: 'created',
    revision: current.revision,
  };
  const state: FrontendAssemblyState = {
    get current() {
      return current;
    },
    get status() {
      return status;
    },
  };
  let startup: HostStartup | undefined;
  let loaderFiber: Fiber | undefined;
  let loader: CatalogLoader | undefined;
  let disposed = false;
  let removeTransportDisconnect: (() => void) | undefined;
  const report = async (next: FrontendHostStatus): Promise<void> => {
    status = next;
    await options.reportStatus?.(next);
    if (options.transport !== undefined) {
      const report: {
        state: HostActivationReport['state'];
        revision: string;
        entries?: readonly HostActivationEntry[];
        error?: HostErrorSummary;
      } = {
        state: next.state,
        revision: next.revision,
      };
      if (next.entries !== undefined) report.entries = next.entries;
      const failure = errorSummary(next.error);
      if (failure !== undefined) report.error = failure;
      try {
        await options.transport.request(HOST_ACTIVATION_REPORT_SERVICE, report);
      } catch (error) {
        const failed: FrontendHostStatus = {
          ...next,
          state: next.state === 'active' ? 'failed' : next.state,
          error,
        };
        status = failed;
        await options.reportStatus?.(failed);
        throw error;
      }
    }
  };
  if (options.transport !== undefined) {
    removeTransportDisconnect = options.transport.onDisconnect((error) => {
      if (disposed) return;
      const failed: FrontendHostStatus = {
        state: 'failed',
        revision: current.revision,
        error,
      };
      status = failed;
      void Promise.resolve(options.reportStatus?.(failed)).catch(() => {});
    });
  }

  try {
    startup = await createHostStartup({
      context,
      startupPlugins: [
        hostFoundationPlugin(state, options.transport),
        ...(options.startupPlugins ?? []),
      ],
    });
    if (options.autoActivate !== false) {
      // Activation is performed below through the returned host so its status
      // callback and failure rollback cover the first assembly as well.
      const host = {
        context,
        ...(options.transport === undefined ? {} : { transport: options.transport }),
        assembly: state,
        ...(ownedContext ? { ownedContext: true } : { ownedContext: false }),
        get status() {
          return status;
        },
        activate: async (_next?: HostAssembly) => {},
        update: async (_next: HostAssembly) => {},
        dispose: async () => {},
      } as FrontendHost;
      await activateFrontendHost(
        host,
        initial,
        options,
        realm,
        () => loader,
        (value) => {
          loader = value.loader;
          loaderFiber = value.fiber;
        },
        report,
        () => {
          current = initial;
        },
      );
    }
  } catch (error) {
    removeTransportDisconnect?.();
    await loaderFiber?.dispose();
    await startup?.dispose();
    throw error;
  }

  const host: FrontendHost = {
    context,
    ...(loader === undefined ? {} : { loader }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    assembly: state,
    ownedContext,
    get status() {
      return status;
    },
    async activate(next = current) {
      await activateFrontendHost(
        host,
        next,
        options,
        realm,
        () => loader,
        (value) => {
          loader = value.loader;
          loaderFiber = value.fiber;
          (host as { loader?: CatalogLoader }).loader = value.loader;
        },
        report,
        () => {
          current = next;
        },
      );
    },
    async update(next) {
      await host.activate(next);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      removeTransportDisconnect?.();
      await loaderFiber?.dispose();
      await startup?.dispose();
      status = { state: 'disposed', revision: current.revision };
    },
  };
  return host;
}

async function activateFrontendHost(
  host: FrontendHost,
  next: HostAssembly,
  options: FrontendHostOptions,
  realm: PluginRealm,
  getLoader: () => CatalogLoader | undefined,
  setLoader: (value: { loader: CatalogLoader; fiber: Fiber }) => void,
  report: (status: FrontendHostStatus) => Promise<void>,
  commit: () => void,
): Promise<void> {
  if (host.status.state === 'disposed') {
    throw new HostAssemblyError(
      'host-assembly-service-unavailable',
      'frontend host to remain active while activating an assembly',
      'Create a new frontend host for the next browser connection.',
      { service: 'host-assembly' },
    );
  }
  const checked = validateHostAssembly(next);
  if (!checked.ok) {
    await report({ state: 'failed', revision: next.revision, error: checked.error });
    throw checked.error;
  }
  const activeLoader = getLoader();
  try {
    if (activeLoader !== undefined)
      assertModuleReloadBoundary(host.assembly.current, checked.value);
    await report({ state: 'loading', revision: next.revision });
    assertModuleVersions(checked.value, options.moduleVersions);
    let loader = activeLoader;
    if (loader === undefined) {
      const catalog = catalogForAssembly(checked.value, options.catalog);
      const installed = await installCatalogLoader(host.context, catalog, realm);
      loader = installed.loader;
      setLoader(installed);
    }
    const entries = projectPluginEntries(checked.value.entries, realm, realm);
    await loader.root.update(entries);
    await loader.await();
    const actualEntries = readiness(loader);
    assertReady(actualEntries);
    commit();
    await report({ state: 'active', revision: checked.value.revision, entries: actualEntries });
  } catch (error) {
    if (error instanceof HostAssemblyError && error.code === 'host-assembly-reload-required') {
      // The old Loader and its active Fibers are still authoritative. Do not
      // publish a failed status for the candidate revision or disguise a
      // required page reload as an in-place activation failure.
      throw error;
    }
    const activeLoader = getLoader();
    const actualEntries = activeLoader === undefined ? undefined : readiness(activeLoader);
    await report({
      state: 'failed',
      revision: next.revision,
      ...(actualEntries === undefined ? {} : { entries: actualEntries }),
      error,
    });
    throw error;
  }
}

export { HostAssemblyError };
