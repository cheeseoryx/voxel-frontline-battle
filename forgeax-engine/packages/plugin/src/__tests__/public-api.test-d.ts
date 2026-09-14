// Public consumer imports validated by scripts/check-public-import-examples.mjs:
// import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
// import { projectPluginEntries } from '@forgeax/engine/plugin/loader';
// import { GameProjectSchema } from '@forgeax/engine/project';

import type { Plugin as ForgePlugin, PluginCompositionError } from '../index.js';
import { definePluginGroup, usePlugin } from '../index.js';
import type { CatalogLoader, CatalogLoaderError, GamePluginEntry } from '../loader.js';
import { projectPluginEntries } from '../loader.js';

const child: ForgePlugin = { name: 'child', apply: () => undefined };
const configuredChild: ForgePlugin.Object<{ readonly speed: number }> = {
  name: 'configured-child',
  apply: (_ctx, config) => config.speed,
};
// @ts-expect-error Plugin.Object config must preserve the declared field type.
usePlugin(configuredChild, { speed: 'not-a-number' }, { key: 'invalid' });
const group = definePluginGroup({
  name: 'gameplay',
  children: () => [usePlugin(child, undefined, { key: 'child' })],
});
const groupUse = usePlugin(group, undefined, { key: 'gameplay' });
const entry: GamePluginEntry = { id: 'gameplay', name: './assets/gameplay.plugin.ts' };
const projectedEntries = projectPluginEntries([entry], 'engine');
async function retryLastKnownGood(
  loader: CatalogLoader,
  entries: Parameters<CatalogLoader['root']['update']>[0],
): Promise<void> {
  await loader.root.update(entries);
  await loader.await();
}
type Assert<T extends true> = T;
type PublicApiAssertions = [
  Assert<typeof group extends ForgePlugin ? true : false>,
  Assert<typeof groupUse.key extends string | undefined ? true : false>,
  Assert<ReturnType<typeof projectPluginEntries> extends readonly object[] ? true : false>,
];
declare const publicApiAssertions: PublicApiAssertions;
void publicApiAssertions;
void projectedEntries;
void retryLastKnownGood;

function recoverPlugin(error: PluginCompositionError | CatalogLoaderError): string {
  switch (error.code) {
    case 'plugin-config-invalid':
      return error.detail.plugin;
    case 'plugin-group-child-failed':
      return error.detail.child;
    case 'plugin-group-dependency-cycle':
      return error.detail.path.join(' > ');
    case 'plugin-group-key-duplicate':
      return error.detail.key;
    case 'plugin-group-key-required':
      return error.detail.plugin;
    case 'plugin-group-provider-missing':
      return error.detail.service;
    case 'plugin-catalog-missing':
      return error.detail.name;
    case 'plugin-realm-mismatch':
      return error.detail.actual;
    case 'plugin-entry-realm-mixed':
      return error.detail.group;
    case 'plugin-realm-unsupported':
      return error.detail.realm;
    case 'plugin-catalog-digest-mismatch':
      return error.detail.actual;
  }
}

void recoverPlugin;
