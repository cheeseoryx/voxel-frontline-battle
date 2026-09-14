/** Open service vocabulary projected onto Cordis Context by capability packages. */
// biome-ignore lint/suspicious/noEmptyInterface: domain packages augment this interface
export interface EngineContextServices {}

declare module '@deepseek-ai/cordis' {
  interface Context extends EngineContextServices {}
}

export * from '@deepseek-ai/cordis';
export { createContextCapabilityResolver } from './capability.js';
export {
  definePluginGroup,
  PluginCompositionError,
  type PluginCompositionErrorArgs,
  type PluginCompositionErrorCode,
  type PluginCompositionErrorDetailByCode,
  type PluginGroupOptions,
  type PluginUse,
  type PluginUseOptions,
  usePlugin,
} from './composition.js';
export {
  type CatalogPluginFiberState,
  type CatalogPluginInspection,
  type CatalogPluginInspectionEntry,
  type CatalogPluginInspectionFailure,
  inspectCatalogPlugins,
} from './inspection.js';
export {
  bootstrapCatalogLoader,
  CatalogLoader,
  type CatalogLoaderBootstrapOptions,
  type CatalogLoaderBootstrapResult,
  type CatalogLoaderBootstrapValue,
  CatalogLoaderError,
  type CatalogLoaderErrorCode,
  type GamePluginEntry,
  installCatalogLoader,
  type PluginCatalog,
  type PluginCatalogRecord,
  type PluginRealm,
  projectPluginEntries,
} from './loader.js';
export {
  defineToolCommandContract,
  isToolCommandContract,
  type ToolCommandContract,
  type ToolCommandDeclaration,
} from './tool-contract.js';
export {
  defineToolPlugin,
  isToolPlugin,
  type ToolPlugin,
} from './tool-plugin.js';
