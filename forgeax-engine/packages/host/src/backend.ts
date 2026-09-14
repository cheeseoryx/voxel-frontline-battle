import { Context, type Fiber, type Plugin } from '@forgeax/engine-plugin';
import {
  bootstrapCatalogLoader,
  type CatalogLoader,
  type CatalogLoaderBootstrapResult,
  type GamePluginEntry,
  type PluginCatalog,
  type PluginRealm,
  projectPluginEntries,
} from '@forgeax/engine-plugin/loader';
import {
  assertHostModuleCatalogIdentity,
  createHostAssembly,
  type HostActivationReport,
  type HostAssembly,
  HostAssemblyError,
  type HostAssemblyInput,
  type HostModuleDescriptor,
  type HostPluginPair,
  modulesFromCatalog,
  validateHostAssembly,
} from './protocol.js';
import { createHostStartup, type HostStartup } from './startup.js';
import {
  createHostTransport,
  HOST_ACTIVATION_REPORT_SERVICE,
  HOST_ASSEMBLY_CHANGED_TOPIC,
  HOST_ASSEMBLY_SERVICE,
  type HostTransportServer,
} from './transport.js';

export interface BackendAssemblyAuthority {
  readonly current: HostAssembly;
  readonly generation: number;
  subscribe(listener: (assembly: HostAssembly) => void): () => void;
}

export interface BackendHostOptions {
  /** Existing domain context may be supplied when App/ECS owns the root. */
  readonly context?: Context;
  /** Always-loaded bootstrap capabilities. Their effects remain Cordis-owned. */
  readonly startupPlugins?: readonly Plugin[];
  /** Optional native Catalog used to activate backend Entries. */
  readonly catalog?: PluginCatalog;
  readonly realm?: PluginRealm;
  readonly entries?: readonly GamePluginEntry[];
  /** Paired backend/frontend identities. Backend Entries are activated locally. */
  readonly pairs?: readonly HostPluginPair[];
  readonly assembly?: HostAssembly;
  readonly modules?: readonly HostModuleDescriptor[];
  readonly config?: unknown;
  readonly transport?: HostTransportServer;
  readonly onActivationReport?: (report: HostActivationReport) => void | Promise<void>;
}

export interface BackendHost {
  readonly context: Context;
  readonly loader?: CatalogLoader;
  readonly assembly: BackendAssemblyAuthority;
  readonly transport: HostTransportServer;
  readonly ownedContext: boolean;
  /** Reconcile backend Entries and publish the matching frontend assembly atomically. */
  update(input: HostAssemblyInput | readonly GamePluginEntry[]): Promise<HostAssembly>;
  dispose(): Promise<void>;
}

function effectiveAssemblyInput(
  current: HostAssembly,
  input: HostAssemblyInput,
): HostAssemblyInput {
  const preservePairs =
    input.pairs === undefined && input.entries === undefined && input.modules === undefined;
  const entriesById = new Map(current.entries.map((entry) => [entry.id, entry]));
  const modulesByName = new Map(current.modules.map((module) => [module.name, module]));
  const pairs = current.pairs.flatMap((pair) => {
    const entry = entriesById.get(pair.entryId);
    const module = modulesByName.get(pair.module.name);
    return entry === undefined || module === undefined
      ? []
      : [{ id: pair.id, frontend: { entry, module } }];
  });
  return {
    entries: input.entries ?? current.entries,
    modules: input.modules ?? current.modules,
    ...(input.pairs !== undefined ? { pairs: input.pairs } : preservePairs ? { pairs } : {}),
    ...(input.config === undefined
      ? current.config === undefined
        ? {}
        : { config: current.config }
      : { config: input.config }),
    ...(input.backendEntries === undefined ? {} : { backendEntries: input.backendEntries }),
  };
}

function authorityOf(initial: HostAssembly): {
  readonly authority: BackendAssemblyAuthority;
  readonly publish: (input: HostAssemblyInput) => HostAssembly;
} {
  let current = initial;
  let generation = 1;
  const listeners = new Set<(assembly: HostAssembly) => void>();
  const authority: BackendAssemblyAuthority = {
    get current() {
      return current;
    },
    get generation() {
      return generation;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    authority,
    publish(input) {
      const next = createHostAssembly(input);
      const checked = validateHostAssembly(next);
      if (!checked.ok) throw checked.error;
      current = checked.value;
      generation += 1;
      for (const listener of listeners) listener(current);
      return current;
    },
  };
}

function hostFoundationPlugin(
  assembly: BackendAssemblyAuthority,
  transport: HostTransportServer,
): Plugin {
  return {
    name: 'forgeax:backend-host-foundation',
    provide: ['hostAssembly', 'hostTransport'],
    apply(ctx) {
      ctx.provide('hostAssembly', assembly);
      ctx.provide('hostTransport', transport);
    },
  };
}

function assertBackendCatalogIdentity(
  catalog: PluginCatalog | undefined,
  modules: readonly HostModuleDescriptor[],
): void {
  if (catalog === undefined) return;
  for (const module of modules) {
    const record = catalog.get(module.name);
    if (record !== undefined) assertHostModuleCatalogIdentity(module, record);
  }
}

/**
 * Start the backend side of the generic Engine host.
 *
 * The function only creates the Cordis root and loads declared bootstrap and
 * Catalog entries. Project, App, World and game policy arrive as plugins.
 */
export async function createBackendHost(options: BackendHostOptions = {}): Promise<BackendHost> {
  const context = options.context ?? new Context();
  const realm = options.realm ?? 'engine';
  const catalog = options.catalog;
  const pairedBackendEntries =
    options.pairs?.flatMap((pair) => (pair.backend === undefined ? [] : [pair.backend.entry])) ??
    [];
  const entries =
    options.entries ??
    options.assembly?.entries ??
    options.pairs?.flatMap((pair) => (pair.frontend === undefined ? [] : [pair.frontend.entry])) ??
    [];
  const modules =
    options.modules ??
    options.assembly?.modules ??
    (options.pairs === undefined
      ? catalog === undefined
        ? []
        : modulesFromCatalog(catalog, realm)
      : options.pairs.flatMap((pair) =>
          pair.frontend === undefined ? [] : [pair.frontend.module],
        ));
  const initialAssembly =
    options.assembly ??
    createHostAssembly({
      entries,
      modules,
      ...(options.pairs === undefined ? {} : { pairs: options.pairs }),
      ...(options.config === undefined ? {} : { config: options.config }),
    });
  const checkedInitial = validateHostAssembly(initialAssembly);
  if (!checkedInitial.ok) {
    if (options.context === undefined) await context.fiber.dispose();
    throw checkedInitial.error;
  }
  const backendModules =
    options.pairs === undefined
      ? modules
      : options.pairs.flatMap((pair) => (pair.backend === undefined ? [] : [pair.backend.module]));
  assertBackendCatalogIdentity(catalog, backendModules);
  const authority = authorityOf(checkedInitial.value);
  const assembly = authority.authority;
  // A DevKit frontend may intentionally reconnect against the provider-only
  // snapshot that bootstrapped this host, while the authority already points
  // at the promoted full assembly from an earlier client.  Keep that one
  // staged revision valid for activation reports; all other revisions must
  // still match the current authority exactly.
  const bootstrapRevision = checkedInitial.value.revision;
  const transport = options.transport ?? createHostTransport();
  let startup: HostStartup | undefined;
  let loaderFiber: Fiber | undefined;
  let loader: CatalogLoader | undefined;
  let backendEntries =
    options.pairs === undefined
      ? (options.entries ?? options.assembly?.entries ?? [])
      : pairedBackendEntries;
  let unregisterAssemblyService: (() => void) | undefined;
  let unregisterActivationService: (() => void) | undefined;
  let unsubscribeAssembly: (() => void) | undefined;
  try {
    startup = await createHostStartup({
      context,
      startupPlugins: [
        hostFoundationPlugin(assembly, transport),
        ...(options.startupPlugins ?? []),
      ],
    });
    if (catalog !== undefined) {
      const bootstrapped = await bootstrapCatalogLoader(context, catalog, realm, {
        catalogDigest: checkedInitial.value.revision,
        supportedRealms: [realm],
      });
      if (!bootstrapped.ok) throw bootstrapped.error;
      loaderFiber = bootstrapped.value.fiber;
      loader = bootstrapped.value.loader;
      if (backendEntries.length > 0) {
        await loader.root.update(projectPluginEntries(backendEntries, realm, realm));
        await loader.await();
      }
    }
    unregisterAssemblyService = transport.register(HOST_ASSEMBLY_SERVICE, () => assembly.current);
    unregisterActivationService = transport.register(
      HOST_ACTIVATION_REPORT_SERVICE,
      async ({ payload }) => {
        const report = payload as HostActivationReport;
        if (
          report.revision !== assembly.current.revision &&
          report.revision !== bootstrapRevision
        ) {
          throw new HostAssemblyError(
            'host-assembly-revision-mismatch',
            `activation report revision ${report.revision} to match ${assembly.current.revision}`,
            'Discard the stale frontend report and fetch the current backend assembly.',
            { actual: report.revision, expected: assembly.current.revision },
          );
        }
        await options.onActivationReport?.(report);
        return { accepted: true };
      },
    );
    unsubscribeAssembly = assembly.subscribe((next) => {
      transport.publish(HOST_ASSEMBLY_CHANGED_TOPIC, next);
    });
  } catch (error) {
    unregisterActivationService?.();
    unregisterAssemblyService?.();
    unsubscribeAssembly?.();
    await loaderFiber?.dispose();
    await startup?.dispose();
    throw error;
  }

  let disposed = false;
  const host: BackendHost = {
    context,
    ...(loader === undefined ? {} : { loader }),
    assembly,
    transport,
    ownedContext: options.context === undefined,
    async update(nextInput) {
      if (disposed) {
        throw new HostAssemblyError(
          'host-assembly-service-unavailable',
          'backend host to remain active while updating Entries',
          'Create a new host instance before updating the disposed host.',
          { service: 'host-assembly' },
        );
      }
      const input: HostAssemblyInput = Array.isArray(nextInput)
        ? {
            entries: nextInput as readonly GamePluginEntry[],
            backendEntries: nextInput as readonly GamePluginEntry[],
          }
        : (nextInput as HostAssemblyInput);
      const effectiveInput = effectiveAssemblyInput(assembly.current, input);
      const candidate = createHostAssembly(effectiveInput);
      const checkedCandidate = validateHostAssembly(candidate);
      if (!checkedCandidate.ok) throw checkedCandidate.error;
      const candidateBackendModules =
        input.pairs === undefined
          ? checkedCandidate.value.modules
          : input.pairs.flatMap((pair) =>
              pair.backend === undefined ? [] : [pair.backend.module],
            );
      assertBackendCatalogIdentity(catalog, candidateBackendModules);
      const nextBackendEntries =
        input.backendEntries ??
        (input.pairs === undefined
          ? (input.entries ?? backendEntries)
          : input.pairs.flatMap((pair) =>
              pair.backend === undefined ? [] : [pair.backend.entry],
            ));
      if (loader === undefined && nextBackendEntries.length > 0) {
        throw new HostAssemblyError(
          'host-assembly-service-unavailable',
          'a CatalogLoader to be installed before updating Entries',
          'Provide a backend Catalog when the host owns plugin Entry activation.',
          { service: 'loader' },
        );
      }
      if (loader !== undefined) {
        await loader.root.update(projectPluginEntries(nextBackendEntries, realm, realm));
        await loader.await();
      }
      backendEntries = nextBackendEntries;
      return authority.publish(effectiveInput);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeAssembly?.();
      unregisterActivationService?.();
      unregisterAssemblyService?.();
      transport.close();
      await loaderFiber?.dispose();
      await startup?.dispose();
    },
  };
  return host;
}

export type { CatalogLoaderBootstrapResult };
export { HostAssemblyError };
