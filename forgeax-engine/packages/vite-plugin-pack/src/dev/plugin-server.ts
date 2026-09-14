import { resolve } from 'node:path';
import type { RunImportMeta, StagedImportPublication } from '@forgeax/engine-import';
import type { CatalogBuildResult, CatalogProducerVisibility } from '@forgeax/engine-pack/build';
import type { ScanSourceDeclaration } from '@forgeax/engine-pack/scanner';
import type {
  AssetPublicationEnvelope,
  CatalogDelta,
  PackIndexEntry,
  RuntimeAssetBinding,
  RuntimeCatalogSnapshot,
} from '@forgeax/engine-types';
import { resolvePackBuildInputs } from '../build-inputs.js';
import type { PluginPackInternalOptions } from '../plugin-contract.js';
import { projectRuntimeDiagnostics } from '../runtime-diagnostics.js';
import type { DispatcherServer, MiddlewareDispatcher } from './dispatcher.js';
import { createMiddlewareDispatcher } from './dispatcher.js';
import {
  createConfigureServer,
  type PluginServerLifecycleState,
} from './plugin-server-configure.js';
import { createProductionBridge, type ProductionBridge } from './production-bridge.js';

export interface PluginServerLike extends DispatcherServer {
  readonly ws?: {
    send(payload: { type: string } & Record<string, unknown>): void;
  };
}

export interface PluginServerState {
  catalogProjection: CatalogBuildResult;
  importedGuids: Set<string>;
  metaPackBodies: Map<string, string>;
  devArtifactBodies: Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }>;
}

export type PluginServerProjectionState = PluginServerState & {
  publicationCandidates: Map<string, AssetPublicationEnvelope>;
  pendingImportPublications: Map<string, StagedImportPublication>;
};

export interface PluginServerCallbacks {
  publishAuthoredDevPacks(
    entries: readonly PackIndexEntry[],
    projection: PluginServerProjectionState,
    declarations?: ReadonlyMap<string, ScanSourceDeclaration>,
    signal?: AbortSignal,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<readonly PackIndexEntry[]>;
  ensureMetaImport(
    metaPath: string,
    declaration?: RunImportMeta,
    signal?: AbortSignal,
    projection?: PluginServerProjectionState,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<PackIndexEntry[]>;
  commitGeneration(candidate: PluginServerProjectionState, signal?: AbortSignal): Promise<void>;
  discardPublications(candidates: ReadonlyMap<string, AssetPublicationEnvelope>): void;
  discardImportPublications(
    candidates: ReadonlyMap<string, StagedImportPublication>,
  ): Promise<void>;
  ensureMetaPackBody(
    url: string,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<string | undefined>;
  setCatalogDeltaPublisher(publisher: (delta: CatalogDelta) => void): void;
}

export interface PluginServerRouteCallbacks {
  materializeAsset(guid: string, signal?: AbortSignal): Promise<readonly PackIndexEntry[]>;
  rebuildAsset(guid: string, signal?: AbortSignal): Promise<readonly PackIndexEntry[]>;
  ensureMetaPackBody(
    url: string,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<string | undefined>;
}

export interface PluginServerContext {
  readonly opts: PluginPackInternalOptions;
  readonly transportBase?: string | undefined;
  /** Current project DDC root used by importer/publication callbacks. */
  readonly projectDdcRoot: string;
  /** Replace the project DDC root before starting the next runtime generation. */
  readonly setProjectDdcRoot: (root: string) => void;
  readonly registeredImporterKeys: ReadonlySet<string>;
  readonly catalogVisibility: CatalogProducerVisibility;
  readonly resetState: () => void;
  readonly scopedPackageUrl: (binding: RuntimeAssetBinding, packageUrl: string) => string;
  readonly scopedCatalogEntry: (
    binding: RuntimeAssetBinding,
    entry: PackIndexEntry,
  ) => PackIndexEntry;
  readonly scopedCatalogResponse: (binding: RuntimeAssetBinding) => RuntimeCatalogSnapshot;
  readonly state: PluginServerState;
  readonly callbacks: PluginServerCallbacks;
  readonly setSourceRefresh: (refresh: (sourcePath: string) => Promise<void>) => void;
}

export function createPluginServer(context: PluginServerContext) {
  const { opts, registeredImporterKeys, catalogVisibility, state, callbacks } = context;
  // Vite may close and then reuse the same plugin object when hosts create
  // sequential servers (for example a preview probe followed by dev/HMR).
  // Keep the old dispatcher terminally closed so its middleware remains a
  // truthful 410, and route the next server through a fresh dispatcher.
  let activeDispatcher = createMiddlewareDispatcher();
  const dispatcher: MiddlewareDispatcher = {
    get registrationCount() {
      return activeDispatcher.registrationCount;
    },
    install(server) {
      activeDispatcher.install(server);
    },
    replace(handler) {
      activeDispatcher.replace(handler);
    },
    close() {
      return activeDispatcher.close();
    },
  };
  const configuredServers = new Set<PluginServerLike>();
  const lifecycle: PluginServerLifecycleState = {
    roots: [...resolvePackBuildInputs({ roots: opts.roots, base: context.transportBase }).roots],
    startupReady: Promise.resolve(),
    stopWatcher: async () => {},
    revisionObserver: undefined,
    watchEpoch: 0,
    configuredServer: undefined,
    devSession: undefined,
  };
  const productionBridge: ProductionBridge = createProductionBridge({
    producerReadiness: opts.producerReadiness,
    ignorePath: opts.ignorePath,
    sourceIdentityFor: opts.sourceIdentityFor,
    transportBase: () => context.transportBase,
    registeredImporterKeys,
    catalogVisibility,
    runtimeBinding: () => lifecycle.devSession?.runtimeScope(),
    roots: () => lifecycle.roots,
    state,
    callbacks,
  });
  const configureServer = createConfigureServer({
    context,
    productionBridge,
    lifecycle,
    configuredServers,
    dispatcher,
    runtimeDiagnostics: projectRuntimeDiagnostics,
  });
  let generationClosed = false;
  let closeInFlight: Promise<void> | undefined;

  const configureServerForGeneration: typeof configureServer = (...args) => {
    generationClosed = false;
    configureServer(...args);
  };

  const rebind = async (
    binding: RuntimeAssetBinding,
    nextRoots: readonly string[],
    nextProjectDdcRoot?: string,
  ): Promise<RuntimeAssetBinding> => {
    const server = lifecycle.configuredServer;
    if (server === undefined) {
      throw new Error('forgeax:pack rebind requires configureServer first');
    }
    const previousProjectDdcRoot = context.projectDdcRoot;
    if (nextProjectDdcRoot !== undefined) {
      context.setProjectDdcRoot(resolve(nextProjectDdcRoot));
    }
    const previousRuntime = lifecycle.devSession?.runtimeScope();
    const previousRoots = [...lifecycle.roots];
    lifecycle.watchEpoch += 1;
    await lifecycle.stopWatcher();
    await lifecycle.devSession?.close();
    productionBridge.replaceSession();
    context.resetState();
    configureServerForGeneration(server, nextRoots, binding);
    await lifecycle.startupReady;
    const failedRebindState = lifecycle.devSession?.state();
    if (failedRebindState?.status === 'failed') {
      const failedRebindFailure = failedRebindState.error;
      const rebindDiagnostics = projectRuntimeDiagnostics([
        {
          code: failedRebindFailure.code,
          message: failedRebindFailure.expected,
          hint: failedRebindFailure.hint,
        },
      ]);
      const failedRebindSession = lifecycle.devSession;
      if (previousRuntime === undefined && failedRebindSession !== undefined) {
        const failedBinding = failedRebindSession.runtimeScope();
        if (failedBinding !== undefined) {
          failedRebindSession.publishRuntime('degraded', 'degraded', rebindDiagnostics);
          return failedRebindSession.runtimeScope() ?? binding;
        }
      }
      await lifecycle.devSession?.close();
      productionBridge.replaceSession();
      context.resetState();
      lifecycle.roots = previousRoots;
      context.setProjectDdcRoot(previousProjectDdcRoot);
      configureServerForGeneration(server, previousRoots, previousRuntime);
      await lifecycle.startupReady;
      const restoredSession = lifecycle.devSession;
      if (restoredSession !== undefined) {
        const restoredBinding = restoredSession.runtimeScope();
        const restoredDiagnostics = [...(restoredBinding?.diagnostics ?? []), ...rebindDiagnostics];
        restoredSession.publishRuntime('degraded', 'degraded', restoredDiagnostics);
      }
      return restoredSession?.runtimeScope() ?? binding;
    }
    return lifecycle.devSession?.runtimeScope() ?? binding;
  };

  // Keep the active scope observable through the same Pack producer that owns
  // rebinding. Consumers must not reach into the private DevSession to decide
  // whether a catalog has been published.
  const runtimeBinding = (): RuntimeAssetBinding | undefined =>
    lifecycle.devSession?.runtimeScope();

  const close = (): Promise<void> => {
    if (closeInFlight !== undefined) return closeInFlight;
    if (generationClosed) return Promise.resolve();
    generationClosed = true;
    const closingDispatcher = activeDispatcher;
    closeInFlight = (async () => {
      lifecycle.watchEpoch += 1;
      await lifecycle.stopWatcher();
      await lifecycle.devSession?.close();
      await productionBridge.session.close();
      configuredServers.clear();
      context.resetState();
      lifecycle.configuredServer = undefined;
      lifecycle.devSession = undefined;
      lifecycle.startupReady = Promise.resolve();
      await closingDispatcher.close();
      activeDispatcher = createMiddlewareDispatcher();
      productionBridge.replaceSession();
    })().finally(() => {
      closeInFlight = undefined;
    });
    return closeInFlight;
  };

  return {
    configureServer: configureServerForGeneration,
    rebind,
    runtimeBinding,
    close,
  };
}
