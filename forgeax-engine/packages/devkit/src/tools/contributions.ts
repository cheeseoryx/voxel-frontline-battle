import {
  createFileSystemPackAuthoringGateway,
  type PackAuthoringOperation,
} from '@forgeax/engine-pack/build';
import type { PACK_AUTHORING_OPERATION_IDS } from '@forgeax/engine-pack/source';
import {
  defineTool,
  type JsonValue,
  type ToolContribution,
  type ToolDomainFailure,
} from '@forgeax/engine-tool-runtime';
import type {
  BuildOptions,
  PluginConfigureOptions,
  PluginInspectOptions,
  PluginInstallOptions,
  PluginToggleOptions,
  PluginUninstallOptions,
} from '../types.js';
import {
  authorPluginConfigureDescriptor,
  authorPluginDisableDescriptor,
  authorPluginEnableDescriptor,
  authorPluginInspectDescriptor,
  authorPluginInstallDescriptor,
  authorPluginUninstallDescriptor,
  packAuthoringToolDescriptors,
  projectBuildDescriptor,
} from './catalog.js';
import { nativePreviewTools } from './preview-catalog.js';

// The historical createPreviewContributions helper is private proof code; the
// discoverable default path uses the native domain preview owners.

function commandFailure(error: {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Record<string, unknown>;
}): { readonly ok: false; readonly error: ToolDomainFailure } {
  return { ok: false, error: { ...error, detail: error.detail as unknown as JsonValue } };
}

export function createBuildContribution(
  projectRoot = process.cwd(),
): ToolContribution<BuildOptions, unknown> {
  return defineTool(
    projectBuildDescriptor as typeof projectBuildDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<BuildOptions>;
    },
    async (options) => {
      const { buildCommand } = await import('../commands.js');
      const result = await buildCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createAuthorContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginInstallOptions, unknown> {
  return defineTool(
    authorPluginInstallDescriptor as typeof authorPluginInstallDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginInstallOptions>;
    },
    async (options) => {
      const { pluginInstallCommand } = await import('../plugin-authoring.js');
      const result = await pluginInstallCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createPackAuthoringContributions(
  projectRoot = process.cwd(),
): readonly ToolContribution<unknown, unknown>[] {
  const gateway = createFileSystemPackAuthoringGateway({ gameRoot: projectRoot });
  return packAuthoringToolDescriptors.map(
    (descriptor) =>
      defineTool(
        descriptor as typeof descriptor & {
          readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PackAuthoringOperation>;
        },
        async (operation) => {
          const id = descriptor.id as (typeof PACK_AUTHORING_OPERATION_IDS)[number];
          const result = await gateway.execute({ ...operation, operation: id });
          return result.ok ? result.value : commandFailure(result.error);
        },
      ) as unknown as ToolContribution<unknown, unknown>,
  );
}

export function createAuthorInspectContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginInspectOptions, unknown> {
  return defineTool(
    authorPluginInspectDescriptor as typeof authorPluginInspectDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginInspectOptions>;
    },
    async (options) => {
      const { pluginInspectCommand } = await import('../plugin-authoring.js');
      const result = await pluginInspectCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createAuthorConfigureContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginConfigureOptions, unknown> {
  return defineTool(
    authorPluginConfigureDescriptor as typeof authorPluginConfigureDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginConfigureOptions>;
    },
    async (options) => {
      const { pluginConfigureCommand } = await import('../plugin-authoring.js');
      const result = await pluginConfigureCommand({
        ...options,
        root: options.root ?? projectRoot,
      });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createAuthorDisableContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginToggleOptions, unknown> {
  return defineTool(
    authorPluginDisableDescriptor as typeof authorPluginDisableDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginToggleOptions>;
    },
    async (options) => {
      const { pluginDisableCommand } = await import('../plugin-authoring.js');
      const result = await pluginDisableCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createAuthorEnableContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginToggleOptions, unknown> {
  return defineTool(
    authorPluginEnableDescriptor as typeof authorPluginEnableDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginToggleOptions>;
    },
    async (options) => {
      const { pluginEnableCommand } = await import('../plugin-authoring.js');
      const result = await pluginEnableCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createAuthorUninstallContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginUninstallOptions, unknown> {
  return defineTool(
    authorPluginUninstallDescriptor as typeof authorPluginUninstallDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginUninstallOptions>;
    },
    async (options) => {
      const { pluginUninstallCommand } = await import('../plugin-authoring.js');
      const result = await pluginUninstallCommand({
        ...options,
        root: options.root ?? projectRoot,
      });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createDefaultContributions(projectRoot = process.cwd()) {
  return [
    createBuildContribution(projectRoot),
    createAuthorContribution(projectRoot),
    createAuthorInspectContribution(projectRoot),
    createAuthorConfigureContribution(projectRoot),
    createAuthorDisableContribution(projectRoot),
    createAuthorEnableContribution(projectRoot),
    createAuthorUninstallContribution(projectRoot),
    ...createPackAuthoringContributions(projectRoot),
    ...nativePreviewTools,
  ];
}
