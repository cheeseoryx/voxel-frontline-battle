import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPluginPackFailure, type PluginPackFailure } from '../errors.js';

export interface WatchedChange {
  /** Absolute path; callers must not reconstruct it against an arbitrary root. */
  readonly filename: string;
}

export interface WatchBatch {
  readonly revision: number;
  readonly sidecars: readonly WatchedChange[];
  readonly sources: readonly WatchedChange[];
}

export type DevWatchListener = (eventType: string, filename: string | Buffer | null) => void;
export type DevWatchFactory = (root: string, listener: DevWatchListener) => FSWatcher;

export interface RevisionObserverOptions {
  readonly roots: readonly string[];
  readonly debounceMs?: number;
  readonly watchFactory?: DevWatchFactory;
  readonly onBatch: (batch: WatchBatch) => void | Promise<void>;
  readonly onError?: (
    error: unknown,
    context: {
      readonly phase: 'watcher' | 'flush' | 'missing-root' | 'snapshot';
      readonly root?: string;
      readonly revision: number;
    },
  ) => void | Promise<void>;
}

export type DevWatcherOptions = RevisionObserverOptions;

export interface DevWatchClassification {
  readonly kind: 'sidecar' | 'source';
}

export interface RevisionObserver {
  readonly ready: Promise<void>;
  readonly reconcile: () => Promise<number>;
  readonly drain: () => Promise<void>;
  readonly revision: () => number;
  readonly close: () => Promise<void>;
}

interface StatFact {
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

type Snapshot = Map<string, StatFact>;

export function classifyWatchedPath(filename: string): DevWatchClassification {
  const isSidecar =
    filename.endsWith('.meta.json') ||
    filename.endsWith('.pack.json') ||
    filename.endsWith('.pack.ts');
  return { kind: isSidecar ? 'sidecar' : 'source' };
}

function snapshotEqual(left: StatFact | undefined, right: StatFact | undefined): boolean {
  return (
    left?.mode === right?.mode && left?.mtimeMs === right?.mtimeMs && left?.size === right?.size
  );
}

async function collectSnapshot(roots: readonly string[]): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  const visit = async (path: string, root: string): Promise<void> => {
    const entry = await lstat(path);
    if (entry.isDirectory()) {
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children) await visit(resolve(path, child.name), root);
      return;
    }
    if (entry.isFile()) {
      snapshot.set(resolve(root, path), {
        mode: entry.mode,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
      });
    }
  };
  for (const root of roots) {
    const absoluteRoot = resolve(root);
    try {
      await visit(absoluteRoot, absoluteRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        root: absoluteRoot,
      });
    }
  }
  return snapshot;
}

function changedPaths(previous: Snapshot, current: Snapshot): readonly string[] {
  const paths = new Set<string>();
  for (const [path, fact] of current) {
    if (!snapshotEqual(previous.get(path), fact)) paths.add(path);
  }
  for (const path of previous.keys()) {
    if (!current.has(path)) paths.add(path);
  }
  return [...paths].sort();
}

function cleanupFailure(): PluginPackFailure {
  return createPluginPackFailure({
    code: 'cleanup-failed',
    expected: 'the revision observer to accept work before close',
    hint: 'create a new dev generation and retry the filesystem operation',
    detail: { stage: 'cleanup', subject: 'revision-observer' },
  });
}

function isCleanupFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'cleanup-failed'
  );
}

export function createRevisionObserver(options: RevisionObserverOptions): RevisionObserver {
  const pendingSidecars = new Map<string, WatchedChange>();
  const pendingSources = new Map<string, WatchedChange>();
  const watchers: FSWatcher[] = [];
  const debounceMs = options.debounceMs ?? 150;
  const probeMs = Math.max(25, Math.min(debounceMs, 100));
  let snapshot: Snapshot = new Map();
  let currentRevision = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let flushInFlight: Promise<void> | undefined;
  let reconcileInFlight: Promise<number> | undefined;
  let reconcileRequested = false;
  let draining = false;

  const report = (
    error: unknown,
    context: {
      readonly phase: 'watcher' | 'flush' | 'missing-root' | 'snapshot';
      readonly root?: string;
      readonly revision?: number;
    },
  ): void => {
    if (options.onError === undefined) {
      console.error('[forgeax-pack] dev watcher failure', error);
      return;
    }
    try {
      const result = options.onError(error, {
        ...context,
        revision: context.revision ?? currentRevision,
      });
      if (result !== undefined) result.catch((nested) => console.error(nested));
    } catch (nested) {
      console.error(nested);
    }
  };

  const flush = async (revision = currentRevision): Promise<void> => {
    if (flushInFlight !== undefined) {
      await flushInFlight;
      if (pendingSidecars.size > 0 || pendingSources.size > 0) await flush(revision);
      return;
    }
    const sidecars = [...pendingSidecars.values()];
    const sources = [...pendingSources.values()];
    pendingSidecars.clear();
    pendingSources.clear();
    if (sidecars.length === 0 && sources.length === 0) return;
    flushInFlight = (async () => {
      try {
        await options.onBatch({ revision, sidecars, sources });
      } catch (error) {
        report(error, { phase: 'flush', revision });
      } finally {
        flushInFlight = undefined;
      }
    })();
    await flushInFlight;
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush().catch((error) => report(error, { phase: 'flush' }));
    }, debounceMs);
    flushTimer.unref();
  };

  const enqueue = (path: string): void => {
    const change = { filename: resolve(path) };
    const target =
      classifyWatchedPath(change.filename).kind === 'sidecar' ? pendingSidecars : pendingSources;
    target.set(change.filename, change);
    scheduleFlush();
  };

  const reconcileNow = async (): Promise<number> => {
    if (disposed) throw cleanupFailure();
    let current: Snapshot;
    try {
      current = await collectSnapshot(options.roots);
    } catch (error) {
      report(error, { phase: 'snapshot' });
      throw error;
    }
    const paths = changedPaths(snapshot, current);
    snapshot = current;
    if (paths.length > 0) {
      currentRevision += 1;
      for (const path of paths) enqueue(path);
    }
    return currentRevision;
  };

  const reconcile = (): Promise<number> => {
    if (disposed) return Promise.reject(cleanupFailure());
    if (reconcileInFlight !== undefined) {
      reconcileRequested = true;
      return reconcileInFlight;
    }
    const task = (async (): Promise<number> => {
      do {
        reconcileRequested = false;
        await reconcileNow();
      } while (reconcileRequested && !disposed);
      return currentRevision;
    })();
    reconcileInFlight = task.finally(() => {
      reconcileInFlight = undefined;
    });
    return reconcileInFlight;
  };

  const drain = async (): Promise<void> => {
    draining = true;
    if (probeTimer !== undefined) {
      clearInterval(probeTimer);
      probeTimer = undefined;
    }
    try {
      while (true) {
        if (reconcileInFlight === undefined && reconcileRequested && !disposed) reconcile();
        await reconcileInFlight;
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        await flush();
        if (!disposed && (reconcileInFlight !== undefined || reconcileRequested)) continue;
        if (
          flushTimer === undefined &&
          flushInFlight === undefined &&
          pendingSidecars.size === 0 &&
          pendingSources.size === 0
        ) {
          return;
        }
      }
    } finally {
      draining = false;
      if (!disposed && probeTimer === undefined) {
        probeTimer = setInterval(() => nativeHint(), probeMs);
        probeTimer.unref();
      }
    }
  };

  const nativeHint = (): void => {
    if (disposed) return;
    if (draining) {
      reconcileRequested = true;
      return;
    }
    void reconcile().catch((error) => {
      // A native hint may already be queued when the owner closes. The
      // queued reconciliation is intentionally rejected by reconcileNow so
      // no new filesystem work can enter a closed generation; that terminal
      // cleanup signal is not a watcher failure and must not be reported.
      if (disposed && isCleanupFailure(error)) return;
      report(error, { phase: 'snapshot' });
    });
  };

  const installWatchers = (): void => {
    const factory =
      options.watchFactory ?? ((root, listener) => fsWatch(root, { recursive: true }, listener));
    for (const root of options.roots) {
      const absoluteRoot = resolve(root);
      try {
        const watcher = factory(absoluteRoot, () => nativeHint());
        watcher.unref();
        watcher.on('error', (error) => report(error, { phase: 'watcher', root: absoluteRoot }));
        watchers.push(watcher);
      } catch (error) {
        report(error, { phase: 'missing-root', root: absoluteRoot });
      }
    }
  };

  const ready = (async (): Promise<void> => {
    try {
      snapshot = await collectSnapshot(options.roots);
    } catch (error) {
      report(error, { phase: 'snapshot' });
    }
    installWatchers();
    try {
      await reconcile();
    } catch (error) {
      if (!disposed || !isCleanupFailure(error)) throw error;
      return;
    }
    if (disposed) return;
    await drain();
  })();

  const close = async (): Promise<void> => {
    if (disposed) {
      await Promise.allSettled([
        ready,
        reconcileInFlight ?? Promise.resolve(),
        flushInFlight ?? Promise.resolve(),
      ]);
      return;
    }
    disposed = true;
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    if (probeTimer !== undefined) clearInterval(probeTimer);
    reconcileRequested = false;
    for (const watcher of watchers) watcher.close();
    pendingSidecars.clear();
    pendingSources.clear();
    await Promise.allSettled([
      ready,
      reconcileInFlight ?? Promise.resolve(),
      flushInFlight ?? Promise.resolve(),
    ]);
  };

  return { ready, reconcile, drain, revision: () => currentRevision, close };
}

export function watchDevRoots(options: DevWatcherOptions): (() => void) & RevisionObserver {
  const observer = createRevisionObserver(options);
  const stop = (() => {
    void observer.close();
  }) as (() => void) & RevisionObserver;
  Object.defineProperties(stop, {
    ready: { enumerable: true, get: () => observer.ready },
    reconcile: { enumerable: true, value: observer.reconcile },
    drain: { enumerable: true, value: observer.drain },
    revision: { enumerable: true, value: observer.revision },
    close: { enumerable: true, value: observer.close },
  });
  return stop;
}
