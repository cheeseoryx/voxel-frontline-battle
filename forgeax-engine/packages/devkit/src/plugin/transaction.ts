import type { CatalogLoader, EntryOptions } from '@forgeax/engine-plugin/loader';
import { type GameProjectPluginEntry, GameProjectSchema } from '@forgeax/engine-project';
import { inspectPluginEntries } from './inspection.js';
import { reconcilePluginEntries } from './reconcile.js';

export type PluginTransactionErrorCode =
  | 'plugin-transaction-disconnected'
  | 'plugin-transaction-manifest-invalid'
  | 'plugin-entry-missing'
  | 'plugin-entry-id-conflict';

export type PluginTransactionError =
  | {
      readonly code: 'plugin-transaction-disconnected';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly live: 'last-known-good' };
    }
  | {
      readonly code: 'plugin-transaction-manifest-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly reason: string };
    }
  | PluginEntryTransactionError;

// Transaction errors are deliberately small and closed. The native Loader
// remains the lifecycle owner; these variants only reject an invalid author
// operation before it can touch the manifest or Fiber tree.
export type PluginEntryTransactionError =
  | {
      readonly code: 'plugin-entry-missing';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly id: string };
    }
  | {
      readonly code: 'plugin-entry-id-conflict';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly id: string };
    };

export interface PluginTransactionInput {
  readonly root: string;
  readonly loader: CatalogLoader;
  readonly readManifest: () => Promise<string>;
  readonly writeManifest: (value: unknown) => Promise<void>;
}

export interface PluginTransaction {
  readonly inspect: () => Promise<ReturnType<typeof inspectPluginEntries>>;
  readonly configure: (id: string, config: unknown) => Promise<{ readonly ok: true }>;
  readonly disable: (id: string) => Promise<{ readonly ok: true }>;
  readonly enable: (id: string) => Promise<{ readonly ok: true }>;
  readonly uninstall: (id: string) => Promise<{ readonly ok: true }>;
  readonly install: (entry: GameProjectPluginEntry) => Promise<{ readonly ok: true }>;
  readonly disconnect: () => Promise<never>;
}

function transactionError(reason: string): PluginTransactionError {
  return {
    code: 'plugin-transaction-manifest-invalid',
    expected: 'forge.json to satisfy GameProjectSchema',
    hint: 'Repair the project manifest before changing plugin installation state.',
    detail: { reason },
  };
}

function entryError(
  code: PluginEntryTransactionError['code'],
  id: string,
): PluginEntryTransactionError {
  return code === 'plugin-entry-missing'
    ? {
        code,
        expected: 'the requested plugin Entry id to exist in forge.json#plugins[]',
        hint: 'Inspect the desired Entry tree and retry with an installed id.',
        detail: { id },
      }
    : {
        code,
        expected: 'the new plugin Entry id to be unique in forge.json#plugins[]',
        hint: 'Choose a stable id that is not already installed.',
        detail: { id },
      };
}

async function readEntries(input: PluginTransactionInput): Promise<{
  readonly value: ReturnType<typeof GameProjectSchema.parse>;
  readonly raw: string;
}> {
  let raw: string;
  try {
    raw = await input.readManifest();
  } catch (cause) {
    throw transactionError(cause instanceof Error ? cause.message : String(cause));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw transactionError(cause instanceof Error ? cause.message : String(cause));
  }
  const result = GameProjectSchema.safeParse(parsed);
  if (!result.success) throw transactionError(result.error.message);
  return { value: result.data, raw };
}

function withoutId(
  entries: readonly GameProjectPluginEntry[],
  id: string,
): GameProjectPluginEntry[] {
  return entries.flatMap((entry) => {
    if (entry.id === id) return [];
    if (entry.group !== true) return [entry];
    return [{ ...entry, config: withoutId(entry.config as readonly GameProjectPluginEntry[], id) }];
  });
}

function updateEntry(
  entries: readonly GameProjectPluginEntry[],
  id: string,
  update: (entry: GameProjectPluginEntry) => GameProjectPluginEntry,
): GameProjectPluginEntry[] {
  return entries.map((entry) => {
    if (entry.id === id) return update(entry);
    if (entry.group !== true) return entry;
    return {
      ...entry,
      config: updateEntry(entry.config as readonly GameProjectPluginEntry[], id, update),
    };
  });
}

function containsId(entries: readonly GameProjectPluginEntry[], id: string): boolean {
  return entries.some(
    (entry) =>
      entry.id === id ||
      (entry.group === true && containsId(entry.config as readonly GameProjectPluginEntry[], id)),
  );
}

function toLoaderEntries(entries: readonly GameProjectPluginEntry[]): EntryOptions[] {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    ...(entry.config === undefined
      ? {}
      : {
          config:
            entry.group === true
              ? toLoaderEntries(entry.config as readonly GameProjectPluginEntry[])
              : entry.config,
        }),
    ...(entry.group === undefined ? {} : { group: entry.group }),
    ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
    ...(entry.inject === undefined ? {} : { inject: entry.inject }),
  }));
}

/** Transaction facade over one native Loader and one persistent manifest callback pair. */
export function createPluginTransaction(input: PluginTransactionInput): PluginTransaction {
  let disconnected = false;
  const assertConnected = (): void => {
    if (disconnected) {
      throw {
        code: 'plugin-transaction-disconnected',
        expected: 'the live plugin Loader to remain connected',
        hint: 'Reconnect the project realm and inspect the last-known-good Fiber tree before retrying.',
        detail: { live: 'last-known-good' },
      } satisfies PluginTransactionError;
    }
  };
  const mutate = async (
    edit: (
      project: ReturnType<typeof GameProjectSchema.parse>,
    ) => ReturnType<typeof GameProjectSchema.parse>,
  ): Promise<{ readonly ok: true }> => {
    assertConnected();
    const previous = await readEntries(input);
    const next = edit(previous.value);
    try {
      await reconcilePluginEntries(input.loader, toLoaderEntries(next.plugins ?? []));
    } catch (cause) {
      // Native Entry/Fiber normally performs its own rollback. Reconcile the
      // complete previous tree as a second fence so a loader adapter that
      // failed after a partial update still exposes the previous LKG.
      await reconcilePluginEntries(
        input.loader,
        toLoaderEntries(previous.value.plugins ?? []),
      ).catch(() => undefined);
      throw cause;
    }
    try {
      await input.writeManifest(next);
    } catch (cause) {
      await reconcilePluginEntries(input.loader, toLoaderEntries(previous.value.plugins ?? []));
      throw cause;
    }
    return { ok: true };
  };

  return {
    async inspect() {
      assertConnected();
      const project = await readEntries(input);
      return inspectPluginEntries(input.loader, toLoaderEntries(project.value.plugins ?? []));
    },
    configure(id, config) {
      return (async () => {
        const project = await readEntries(input);
        if (!containsId(project.value.plugins ?? [], id))
          throw entryError('plugin-entry-missing', id);
        return mutate((value) => ({
          ...value,
          plugins: updateEntry(value.plugins ?? [], id, (entry) => ({ ...entry, config })),
        }));
      })();
    },
    disable(id) {
      return (async () => {
        const project = await readEntries(input);
        if (!containsId(project.value.plugins ?? [], id))
          throw entryError('plugin-entry-missing', id);
        return mutate((value) => ({
          ...value,
          plugins: updateEntry(value.plugins ?? [], id, (entry) => ({ ...entry, disabled: true })),
        }));
      })();
    },
    enable(id) {
      return (async () => {
        const project = await readEntries(input);
        if (!containsId(project.value.plugins ?? [], id))
          throw entryError('plugin-entry-missing', id);
        return mutate((value) => ({
          ...value,
          plugins: updateEntry(value.plugins ?? [], id, (entry) => ({ ...entry, disabled: false })),
        }));
      })();
    },
    uninstall(id) {
      return (async () => {
        const project = await readEntries(input);
        if (!containsId(project.value.plugins ?? [], id))
          throw entryError('plugin-entry-missing', id);
        return mutate((value) => ({ ...value, plugins: withoutId(value.plugins ?? [], id) }));
      })();
    },
    install(entry) {
      return (async () => {
        const project = await readEntries(input);
        if (containsId(project.value.plugins ?? [], entry.id)) {
          throw entryError('plugin-entry-id-conflict', entry.id);
        }
        return mutate((value) => ({ ...value, plugins: [...(value.plugins ?? []), entry] }));
      })();
    },
    async disconnect() {
      disconnected = true;
      assertConnected();
      throw new Error('unreachable');
    },
  };
}
