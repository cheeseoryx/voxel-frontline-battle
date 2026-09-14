import {
  type CatalogPluginFiberState,
  type CatalogPluginInspectionEntry,
  inspectCatalogPlugins,
} from '@forgeax/engine-plugin';
import type { CatalogLoader, EntryOptions } from '@forgeax/engine-plugin/loader';

export type PluginFiberState = CatalogPluginFiberState;
export type PluginInspectionEntry = CatalogPluginInspectionEntry;

export interface PluginInspection {
  readonly desired: readonly EntryOptions[];
  readonly live: readonly PluginInspectionEntry[];
  readonly entries: readonly PluginInspectionEntry[];
}

/** Join the desired project EntryTree with the native Loader projection. */
export function inspectPluginEntries(
  loader: CatalogLoader,
  desired: readonly EntryOptions[],
): PluginInspection {
  const { live } = inspectCatalogPlugins(loader);
  return { desired, live, entries: live };
}
