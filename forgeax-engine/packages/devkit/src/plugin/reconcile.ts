import type { CatalogLoader, EntryOptions } from '@forgeax/engine-plugin/loader';

/** Reconcile the desired EntryTree through the native Loader owner. */
export async function reconcilePluginEntries(
  loader: CatalogLoader,
  entries: readonly EntryOptions[],
): Promise<void> {
  await loader.root.update([...entries]);
  await loader.await();
}
