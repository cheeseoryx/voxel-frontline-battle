import { resolve } from 'node:path';
import {
  containsSourcePackageError,
  normalizeSourcePackageError,
  parseProducerReadiness,
} from '@forgeax/engine-import';
import { type CatalogBuildError, calculateCatalogDelta } from '@forgeax/engine-pack/build';
import type { CatalogDelta, CatalogDiagnostic, RuntimeAssetBinding } from '@forgeax/engine-types';
import { resolvePackBuildInputs } from '../build-inputs.js';
import { CATALOG_DELTA_EVENT } from '../catalog-transport.js';
import { createPluginPackFailure } from '../errors.js';
import type { projectRuntimeDiagnostics } from '../runtime-diagnostics.js';
import { createDevSession, type DevSession } from './dev-session.js';
import type { MiddlewareDispatcher } from './dispatcher.js';
import type { PluginServerContext, PluginServerLike, PluginServerState } from './plugin-server.js';
import type { ProductionBridge } from './production-bridge.js';
import { createProductionRouteBridge } from './production-bridge.js';
import {
  catalogDiagnosticForSourcePackageError,
  createTransportRouteHandler,
  projectSourcePackageFailure,
} from './transport-routes.js';
import {
  classifyWatchedPath,
  createRevisionObserver,
  type RevisionObserver,
  type WatchBatch,
} from './watcher.js';

export interface PluginServerLifecycleState {
  roots: string[];
  startupReady: Promise<void>;
  stopWatcher: () => Promise<void>;
  revisionObserver: RevisionObserver | undefined;
  watchEpoch: number;
  configuredServer: PluginServerLike | undefined;
  devSession: DevSession | undefined;
}

interface ConfigureServerInput {
  readonly context: PluginServerContext;
  readonly productionBridge: ProductionBridge;
  readonly lifecycle: PluginServerLifecycleState;
  readonly configuredServers: Set<PluginServerLike>;
  readonly dispatcher: MiddlewareDispatcher;
  readonly runtimeDiagnostics: typeof projectRuntimeDiagnostics;
}

interface WatchBatchInput {
  readonly server: PluginServerLike;
  readonly refresh: PluginServerContext['opts']['refresh'];
  readonly state: PluginServerState;
  readonly productionBridge: ProductionBridge;
  readonly session: ProductionBridge['session'];
  readonly activeDevSession: DevSession;
  readonly generationActive: () => boolean;
  readonly sendCatalogDelta: (delta: CatalogDelta) => void;
}

function degradedSnapshot(session: ProductionBridge['session'], state: PluginServerState) {
  return {
    generation: session.runtimeGeneration,
    catalog: [...state.catalogProjection.entries],
    authority: 'degraded' as const,
    diagnostics: [],
  };
}

function projectCatalogDiagnostics(
  diagnostics: readonly CatalogBuildError[],
): readonly CatalogDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    severity: 'blocking' as const,
    authority: 'catalog' as const,
  }));
}

/** @internal — kept exported so the source-failure path has a direct regression gate. */
export function rowMatchesChangedPath(
  row: { readonly guid: string; readonly sourcePath: string },
  changedPaths: ReadonlySet<string>,
  state: PluginServerState,
): boolean {
  if (changedPaths.has(resolve(process.cwd(), row.sourcePath))) return true;
  for (const [declarationPath, declaration] of state.catalogProjection.declarations) {
    // Imported rows publish the resolved source path (for example the GLB),
    // while the declaration map is keyed by its `.meta.json` sidecar. A
    // source edit therefore has to match both coordinates; checking only the
    // sidecar leaves the row `current` even though its producer just failed.
    const declarationChanged =
      changedPaths.has(resolve(declarationPath)) || changedPaths.has(resolve(declaration.source));
    if (!declarationChanged) continue;
    if (
      declaration.subAssets.some((asset) => asset.guid.toLowerCase() === row.guid.toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

function deepestCause(error: unknown, seen = new Set<unknown>()): unknown {
  if (error === null || typeof error !== 'object' || seen.has(error)) return error;
  seen.add(error);
  const cause = (error as { readonly cause?: unknown }).cause;
  return cause === undefined ? error : deepestCause(cause, seen);
}

function createWatchBatchApplier(input: WatchBatchInput) {
  return async ({ sidecars, sources }: WatchBatch): Promise<void> => {
    if (!input.generationActive()) return;
    const changedPaths = new Set<string>(
      [...sidecars, ...sources].map((info) => resolve(info.filename)),
    );
    const invalidatedPackUrls = new Set<string>();
    for (const guid of input.state.importedGuids) {
      const row = input.state.catalogProjection.entries.find(
        (candidate) => candidate.guid.toLowerCase() === guid,
      );
      if (row === undefined) continue;
      // Authored Pack rows are rebuilt and published by this watcher itself;
      // imported Meta rows leave the imported set and wait for an explicit
      // reimport route. Keep every existing body in the projection as the
      // last-known-good payload until the next generation commits; deleting it
      // here would turn a recoverable producer failure into a 404.
      if (row.sourcePath.endsWith('.pack.ts') || row.sourcePath.endsWith('.pack.json')) continue;
      if (!rowMatchesChangedPath(row, changedPaths, input.state)) continue;
      invalidatedPackUrls.add(row.packageUrl);
      input.state.importedGuids.delete(guid);
    }
    const importedRowsInvalidated = invalidatedPackUrls.size > 0;
    let rebuildState: Awaited<ReturnType<DevSession['rebuild']>> | undefined;

    if (sidecars.length > 0 || sources.length > 0 || importedRowsInvalidated) {
      const next = await input.activeDevSession.rebuild(async ({ previous }) => {
        const previousSnapshot = previous ?? degradedSnapshot(input.session, input.state);
        try {
          const inventory = await input.productionBridge.inventoryForRequest(false, input.session);
          if (!input.generationActive()) return previousSnapshot;
          const affectedSourceRows = previousSnapshot.catalog.filter((row) =>
            rowMatchesChangedPath(row, changedPaths, input.state),
          );
          const catalogDelta = calculateCatalogDelta(
            previousSnapshot.catalog,
            input.state.catalogProjection.entries,
          );
          const sourceRevisionDiagnostic: CatalogDiagnostic | undefined =
            changedPaths.size > 0 && affectedSourceRows.length > 0 && catalogDelta === undefined
              ? {
                  code: 'catalog-revision-conflict',
                  severity: 'blocking',
                  expected: 'a source payload change to advance its catalog revision',
                  actual: 'source bytes changed without a catalog revision change',
                  hint: 'repair the source revision and publish the next catalog snapshot',
                  authority: 'catalog',
                  evidence: affectedSourceRows.map((row) => ({
                    type: 'asset' as const,
                    id: row.guid,
                  })),
                }
              : undefined;
          const diagnostics = [
            ...projectCatalogDiagnostics(inventory.diagnostics),
            ...(sourceRevisionDiagnostic === undefined ? [] : [sourceRevisionDiagnostic]),
          ];
          const delta: CatalogDelta | undefined =
            sourceRevisionDiagnostic === undefined
              ? catalogDelta
              : {
                  added: [],
                  changed: [],
                  removed: [],
                  authority: 'degraded',
                  diagnostics: [sourceRevisionDiagnostic],
                };
          if (delta !== undefined) {
            input.sendCatalogDelta(delta);
          }
          return {
            generation: input.session.runtimeGeneration,
            catalog: [...input.state.catalogProjection.entries],
            authority: sourceRevisionDiagnostic === undefined ? inventory.authority : 'degraded',
            diagnostics,
          };
        } catch (error: unknown) {
          if (!input.generationActive()) return previousSnapshot;
          const diagnostic = deepestCause(error);
          console.warn('[forgeax-pack] rebuild state.catalog error:', diagnostic);
          const affectedSourceRows = previousSnapshot.catalog.filter((row) =>
            rowMatchesChangedPath(row, changedPaths, input.state),
          );
          if (affectedSourceRows.length > 0 && containsSourcePackageError(error)) {
            const first = affectedSourceRows[0];
            if (first !== undefined) {
              const sourceMeta =
                [...input.state.catalogProjection.declarations.entries()].find(([, declaration]) =>
                  declaration.subAssets.some(
                    (asset) => asset.guid.toLowerCase() === first.guid.toLowerCase(),
                  ),
                )?.[0] ?? first.sourcePath;
              const normalized = normalizeSourcePackageError(error, {
                sourceMeta,
                anchorGuid: first.guid,
                affectedGuids: affectedSourceRows.map((row) => row.guid),
                producer: first.provenance?.provider ?? 'plugin-pack',
                importer:
                  [...input.state.catalogProjection.declarations.values()].find((declaration) =>
                    declaration.subAssets.some(
                      (asset) => asset.guid.toLowerCase() === first.guid.toLowerCase(),
                    ),
                  )?.importer ??
                  first.provenance?.provider ??
                  'unknown',
              });
              const failedEntries = projectSourcePackageFailure(
                previousSnapshot.catalog,
                normalized,
              );
              input.state.catalogProjection = {
                ...input.state.catalogProjection,
                entries: failedEntries,
              };
              const sourceDiagnostic = catalogDiagnosticForSourcePackageError(normalized);
              // Failed rows remain server-side evidence for the next repair, but a
              // degraded delta is intentionally non-identity-bearing. Publishing
              // failed rows would make the browser fetch the known-bad locator
              // before it can retain its last-known-good payload.
              input.sendCatalogDelta({
                added: [],
                changed: [],
                removed: [],
                authority: 'degraded',
                diagnostics: [sourceDiagnostic],
              });
              return {
                generation: input.session.runtimeGeneration,
                catalog: [...failedEntries],
                authority: 'degraded' as const,
                diagnostics: [...previousSnapshot.diagnostics, sourceDiagnostic],
              };
            }
          }
          const failure =
            diagnostic !== null && typeof diagnostic === 'object' ? diagnostic : undefined;
          const watchDiagnostic: CatalogDiagnostic = {
            code:
              failure !== undefined && 'code' in failure && typeof failure.code === 'string'
                ? failure.code
                : 'catalog-rebuild-failed',
            severity: 'blocking',
            authority: 'producer',
            expected:
              failure !== undefined && 'expected' in failure && typeof failure.expected === 'string'
                ? failure.expected
                : 'the changed source to produce an accepted Catalog snapshot',
            ...(failure !== undefined && 'actual' in failure && typeof failure.actual === 'string'
              ? { actual: failure.actual }
              : {}),
            hint:
              failure !== undefined && 'hint' in failure && typeof failure.hint === 'string'
                ? failure.hint
                : 'repair the source, rebuild, and retry the Catalog update',
          };
          input.sendCatalogDelta({
            added: [],
            changed: [],
            removed: [],
            authority: 'degraded',
            diagnostics: [watchDiagnostic],
          });
          return {
            ...previousSnapshot,
            authority: 'degraded' as const,
            diagnostics: [...previousSnapshot.diagnostics, watchDiagnostic],
          };
        }
      });
      rebuildState = next;
    }
    if (!input.generationActive()) return;
    const hasCatalogSidecar = [...sidecars].some(
      (info) => classifyWatchedPath(info.filename).kind === 'sidecar',
    );
    const rebuildStatus = rebuildState?.status;
    const rebuildDegraded = rebuildStatus === 'degraded' || rebuildStatus === 'failed';
    if (input.refresh !== undefined) {
      // A failed Catalog transaction retains its accepted LKG and publishes a
      // diagnostic. Refreshing the page here would discard that recovery path.
      if (!rebuildDegraded && !(hasCatalogSidecar && rebuildStatus === 'serving')) {
        input.refresh(input.server);
      }
    } else if (!rebuildDegraded && !hasCatalogSidecar && rebuildStatus === 'serving') {
      input.server.ws?.send({ type: 'full-reload' });
    }
    const parts: string[] = [];
    if (sidecars.length > 0) parts.push(`${sidecars.length} sidecar`);
    if (sources.length > 0) parts.push(`${sources.length} source`);
    console.warn(`[forgeax-pack] assets changed: ${parts.join(', ')} (reloaded)`);
  };
}

export function createConfigureServer(input: ConfigureServerInput) {
  return (
    server: PluginServerLike,
    overrideRoots?: readonly string[],
    overrideRuntimeBinding?: RuntimeAssetBinding,
  ): void => {
    const { context, productionBridge, lifecycle, configuredServers, dispatcher } = input;
    const { opts, transportBase, state, callbacks } = context;
    dispatcher.install(server);
    configuredServers.add(server);
    if (lifecycle.configuredServer !== undefined && overrideRoots === undefined) return;
    lifecycle.configuredServer = server;
    lifecycle.roots = [
      ...(overrideRoots ??
        resolvePackBuildInputs({ roots: opts.roots, base: transportBase }).roots),
    ];
    const runtimeBinding = overrideRuntimeBinding ?? opts.runtimeBinding;
    const session = productionBridge.session;
    const activeDevSession = createDevSession({
      generation: 1,
      productionSession: session,
      startup: async () => {
        const inventory = await productionBridge.inventoryForRequest(true, session);
        const readiness = parseProducerReadiness(opts.producerReadiness);
        if (!readiness.ok) {
          const diagnostic: CatalogBuildError = {
            code: 'catalog-scan-failed',
            path: 'pluginPack.producerReadiness',
            message: readiness.error.hint,
            expected: readiness.error.expected,
            actual: String(readiness.error.detail.value),
            hint: readiness.error.hint,
          };
          state.catalogProjection = {
            ...state.catalogProjection,
            schemaVersion: 'catalog-legacy-v1',
            entries: [],
            authority: 'degraded',
            diagnostics: [diagnostic],
          };
          throw createPluginPackFailure({
            code: 'config-failed',
            expected: readiness.error.expected,
            hint: readiness.error.hint,
            detail: { stage: 'config', subject: diagnostic.path },
            cause: readiness.error,
          });
        }
        const diagnostics = projectCatalogDiagnostics(inventory.diagnostics);
        if (inventory.authority !== 'authoritative' && inventory.entries.length === 0) {
          throw createPluginPackFailure({
            code: 'scan-failed',
            expected: 'an authoritative Catalog projection',
            hint: 'inspect catalog diagnostics, repair the root, rebuild, and retry',
            detail: { stage: 'scan', subject: 'catalog' },
            cause: inventory.diagnostics,
          });
        }
        const binding = activeDevSession.runtimeScope();
        if (binding?.status === 'transitioning') {
          activeDevSession.publishRuntime(
            inventory.authority === 'authoritative' ? 'ready' : 'degraded',
            inventory.authority,
            input.runtimeDiagnostics(inventory.diagnostics),
          );
        }
        return {
          generation: session.runtimeGeneration,
          catalog: [...state.catalogProjection.entries],
          authority: inventory.authority,
          diagnostics,
        };
      },
    });
    if (runtimeBinding !== undefined) activeDevSession.bindRuntime(runtimeBinding);
    const sendCatalogDelta = (delta: CatalogDelta): void => {
      const binding = activeDevSession.runtimeScope();
      for (const target of configuredServers) {
        target.ws?.send({
          type: 'custom',
          event: CATALOG_DELTA_EVENT,
          data:
            binding === undefined
              ? delta
              : {
                  ...delta,
                  scopeId: binding.scopeId,
                  generation: binding.generation,
                  // A delta replaces complete replica rows. Keep the same
                  // transport projection as enumeration, never raw DDC URLs.
                  added: delta.added.map((entry) => context.scopedCatalogEntry(binding, entry)),
                  changed: delta.changed.map((entry) => context.scopedCatalogEntry(binding, entry)),
                },
        });
      }
    };
    callbacks.setCatalogDeltaPublisher(sendCatalogDelta);
    lifecycle.devSession = activeDevSession;
    const sessionReady = activeDevSession.start();
    const epoch = ++lifecycle.watchEpoch;
    const generationActive = (): boolean =>
      epoch === lifecycle.watchEpoch &&
      !session.signal.aborted &&
      !['closing', 'closed'].includes(activeDevSession.state().status);
    context.setSourceRefresh(async () => {
      if (!generationActive()) {
        throw createPluginPackFailure({
          code: 'cleanup-failed',
          expected: 'the active dev generation to accept a source refresh',
          hint: 'wait for the next Vite generation before requesting the Pack body',
          detail: { stage: 'cleanup', subject: 'source-refresh' },
        });
      }
      let result = await activeDevSession.rebuildProduction(
        lifecycle.roots.map((sourceKey) => ({ sourceKey })),
      );
      if (result.status === 'stale') {
        result = await activeDevSession.rebuildProduction(
          lifecycle.roots.map((sourceKey) => ({ sourceKey })),
        );
      }
      if (result.status === 'failed') throw result.error;
      if (result.status === 'stale') {
        throw createPluginPackFailure({
          code: 'stale-generation',
          expected: 'the source refresh generation to remain current',
          hint: 'retry the Pack body request after the active generation settles',
          detail: { stage: 'route', subject: 'source-refresh' },
        });
      }
    });
    const applyWatchBatch = createWatchBatchApplier({
      server,
      refresh: opts.refresh,
      state,
      productionBridge,
      session,
      activeDevSession,
      generationActive,
      sendCatalogDelta,
    });
    const observer = createRevisionObserver({
      roots: lifecycle.roots,
      onBatch: (batch) => {
        return activeDevSession.track(
          sessionReady.then(async () => {
            if (epoch !== lifecycle.watchEpoch) return;
            await applyWatchBatch(batch);
          }),
        );
      },
      onError: (error, watchContext) => {
        if (activeDevSession.state().status === 'starting') return;
        void activeDevSession.rebuild(async ({ previous }) => {
          const failure = createPluginPackFailure({
            code: 'watch-failed',
            expected: 'the watcher and batch intake to remain available',
            hint: 'inspect the watcher diagnostic, repair the root, rebuild, verify, and retry',
            detail: {
              stage: 'watch',
              subject: watchContext.root ?? lifecycle.roots[0] ?? 'watcher',
            },
            cause: error,
          });
          return {
            ...(previous ?? degradedSnapshot(session, state)),
            authority: 'degraded' as const,
            diagnostics: [
              ...(previous?.diagnostics ?? []),
              {
                code: failure.code,
                severity: 'blocking' as const,
                authority: 'producer' as const,
                expected: failure.expected,
                actual: failure.detail.stage,
                hint: failure.hint,
              },
            ],
          };
        });
      },
    });
    lifecycle.revisionObserver = observer;
    lifecycle.stopWatcher = observer.close;
    lifecycle.startupReady = Promise.all([sessionReady, observer.ready]).then(() => undefined);
    const freshnessBarrier = async (): Promise<void> => {
      await observer.reconcile();
      await observer.drain();
      await activeDevSession.waitForRebuild();
    };
    const routeCallbacks = createProductionRouteBridge({
      callbacks,
      activeDevSession,
      roots: lifecycle.roots,
      producerReadiness: opts.producerReadiness,
      freshnessBarrier,
      state,
    });
    dispatcher.replace(
      createTransportRouteHandler({
        startupReady: lifecycle.startupReady,
        transportBase,
        state,
        callbacks: routeCallbacks,
        freshnessBarrier,
        scopedPackageUrl: context.scopedPackageUrl,
        scopedCatalogResponse: context.scopedCatalogResponse,
        devSession: activeDevSession,
      }),
    );
  };
}
