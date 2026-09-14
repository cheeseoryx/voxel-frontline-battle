/**
 * Browser-safe ForgeaX Cordis surface.
 *
 * The native Catalog Loader is intentionally kept on the Node-facing root
 * implementation and `/loader` subpath. Importing it would evaluate
 * `@deepseek-ai/cordis-plugin-loader`, whose `node:module` dependency cannot
 * exist in a browser bundle. Browser consumers still receive the same Cordis,
 * ToolPlugin, and capability-resolver contracts without that Node-only edge.
 */
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
