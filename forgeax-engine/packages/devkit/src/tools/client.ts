import {
  createToolCommandRegistry,
  createToolRuntime,
  defineCommand,
  type JsonValue,
  type ToolCommandHelp,
  type ToolCommandNode,
  type ToolContribution,
  type ToolJsonSchema,
  type ToolRunOptions,
  type ToolTerminal,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import {
  commandPathForToolId,
  createProjectToolCatalogAuthority,
  createRealmDispatch,
  describeTool,
  listTools,
  loadToolCatalog,
  materializeToolDescriptorCatalog,
  type ToolCatalogEntry,
  type ToolRealmOwner,
} from './catalog.js';
import { decorateResourcePreviewTerminal } from './cli-adapter.js';
import { retiredPreviewTool } from './preview-migration.js';
import type { ProjectToolBinding, ProjectToolDiscoveryOptions } from './project-tools.js';

export interface ToolClientOptions extends ProjectToolDiscoveryOptions {
  readonly projectRoot: string;
  /** Optional physical realm owners used by a host/carrier integration. */
  readonly realmOwners?: readonly ToolRealmOwner[];
  /** Injectable builtins for physical host tests and alternate Engine adapters. */
  readonly baseContributions?: readonly ToolContribution[];
  readonly projectDiscovery?: (projectRoot: string) => Promise<readonly ProjectToolBinding[]>;
}

export interface ToolClient {
  readonly list: () => readonly ToolCatalogEntry[];
  readonly describe: (id: string) => ToolCatalogEntry | undefined;
  readonly help: (path?: readonly string[] | string, tree?: boolean) => ToolCommandHelp;
  readonly tree: (path?: readonly string[] | string) => readonly ToolCommandNode[];
  readonly runPath: <TResult = unknown>(
    path: readonly string[] | string,
    args: unknown,
    options?: ToolRunOptions,
  ) => Promise<ToolTerminal<TResult>>;
  readonly run: <TResult = unknown>(
    id: string,
    args: unknown,
    options?: ToolRunOptions,
  ) => Promise<ToolTerminal<TResult>>;
}

interface HelpArgs {
  readonly path?: readonly string[];
  readonly tree?: boolean;
}

function missingTool(id: string): ToolTerminal<never> {
  return {
    outcome: 'failed',
    failure: {
      code: 'tool-capability-unavailable',
      expected: `tool ${id} to exist in the project-derived catalog`,
      hint: 'Run forgeax help --tree and choose one of the discovered command paths.',
      detail: { capability: `tool:${id}`, realm: 'build' },
    },
    artifacts: [],
  };
}

export async function createToolClient(options: ToolClientOptions): Promise<ToolClient> {
  const projectDiscovery = options.projectDiscovery;
  const runProjectTool =
    projectDiscovery === undefined
      ? (await import('./project-tools.js')).runProjectTool
      : undefined;
  const builtins = options.baseContributions ?? [
    ...(await import('./contributions.js')).createDefaultContributions(options.projectRoot),
    ...(await import('./unified-contributions.js')).createUnifiedCommandContributions(
      options.projectRoot,
    ),
  ];
  // Project command contracts are an extension surface. A malformed or
  // missing extension must not hide the built-in command tree: help, status,
  // and project diagnostics remain useful while the extension reports its
  // own load failure when invoked.
  let project: readonly ProjectToolBinding[] = [];
  let projectDiscoveryFailure: unknown;
  if (projectDiscovery === undefined) {
    try {
      project = await (await import('./project-tools.js')).discoverProjectTools(
        options.projectRoot,
        options,
      );
    } catch (error) {
      projectDiscoveryFailure = error;
      project = [];
    }
  } else {
    try {
      project = await projectDiscovery(options.projectRoot);
    } catch (error) {
      projectDiscoveryFailure = error;
      project = [];
    }
  }
  let commandRegistry: ReturnType<typeof createToolCommandRegistry>;
  const helpArgsSchema = {
    type: 'object',
    properties: {
      path: { type: 'array', items: { type: 'string' } },
      tree: { type: 'boolean' },
    },
    additionalProperties: false,
  } satisfies ToolJsonSchema;
  const helpContribution = defineCommand<HelpArgs, ToolCommandHelp>(
    {
      id: 'help',
      path: ['help'],
      title: 'Show help',
      summary: 'Progressively discover commands and print the command tree.',
      realm: 'build',
      argsSchema: toolJsonSchema<HelpArgs>(helpArgsSchema),
      resultSchema: toolJsonSchema<ToolCommandHelp>({ type: 'object' }),
      evidence: [],
      capabilities: [],
      errors: ['tool-invalid-args', 'tool-command-not-found'],
      inputSchema: helpArgsSchema as JsonValue,
    },
    (args) => commandRegistry.help(args.path ?? [], args.tree === true),
  );
  const contributions = [...builtins, ...project.map(({ contribution }) => contribution)].map(
    (contribution) => ({
      ...contribution,
      descriptor: {
        ...contribution.descriptor,
        path: contribution.descriptor.path ?? commandPathForToolId(contribution.descriptor.id),
      },
    }),
  ) as readonly ToolContribution[];
  const allContributions = [helpContribution, ...contributions] as readonly ToolContribution[];
  commandRegistry = createToolCommandRegistry(allContributions);
  const runtime =
    options.baseContributions === undefined
      ? (await import('./runtime.js')).createDevkitToolRuntime(
          allContributions as readonly unknown[],
        )
      : createToolRuntime(allContributions as readonly unknown[]);
  const realmDispatch =
    options.realmOwners === undefined
      ? undefined
      : createRealmDispatch(allContributions, options.realmOwners);
  const bindingById = new Map<string, ProjectToolBinding>(
    project.map((binding) => [binding.contribution.descriptor.id, binding]),
  );
  const descriptors = runtime.list();
  const loadedResult = await loadToolCatalog(
    createProjectToolCatalogAuthority(options.projectRoot, descriptors),
    descriptors,
  );
  const loaded = loadedResult.ok
    ? loadedResult.value
    : materializeToolDescriptorCatalog(descriptors, { authorityDigest: 'sha256:unbound-project' });
  const runTool = async <TResult = unknown>(
    id: string,
    args: unknown,
    runOptions: ToolRunOptions = {},
  ): Promise<ToolTerminal<TResult>> => {
    if (id === 'preview.run') return retiredPreviewTool() as ToolTerminal<TResult>;
    const contribution = runtime.get(id);
    if (contribution === undefined) return missingTool(id) as ToolTerminal<TResult>;
    const binding = bindingById.get(id);
    const nativePreview =
      binding === undefined && id.endsWith('.preview')
        ? await import('./native-preview.js')
        : undefined;
    let terminal =
      nativePreview?.isNativePreviewTool(id) === true
        ? await nativePreview.runNativePreviewTool(
            contribution as ToolContribution<unknown, unknown>,
            args,
            runOptions,
            options.projectRoot,
          )
        : binding !== undefined && runProjectTool !== undefined
          ? await runProjectTool(binding, args, runOptions)
          : realmDispatch === undefined
            ? await runtime.run(contribution, args, runOptions).terminal
            : await realmDispatch.run(id, args, runOptions);
    terminal = decorateResourcePreviewTerminal(terminal as ToolTerminal<TResult>);
    if (id === 'project.plugin.list' && projectDiscoveryFailure !== undefined) {
      const reason =
        projectDiscoveryFailure instanceof Error
          ? projectDiscoveryFailure.message
          : String(projectDiscoveryFailure);
      if (terminal.outcome === 'succeeded') {
        const current = terminal.result;
        terminal = {
          ...terminal,
          result: {
            ...(current !== null && typeof current === 'object' && !Array.isArray(current)
              ? current
              : { value: current }),
            extensionDiscovery: {
              ok: false,
              error: {
                code: 'project-command-discovery-failed',
                expected: 'project command contract modules to load without side effects',
                hint: 'Repair the commandContract module; built-in commands remain available.',
                detail: { reason },
              },
            },
          },
        } as ToolTerminal<TResult>;
      }
    }
    return terminal as ToolTerminal<TResult>;
  };
  return {
    list: () => listTools(loaded),
    describe: (id) => describeTool(loaded, id),
    help: (path, tree = false) => commandRegistry.help(path, tree),
    tree: (path = []) => commandRegistry.tree(path),
    async runPath<TResult = unknown>(
      path: readonly string[] | string,
      args: unknown,
      runOptions: ToolRunOptions = {},
    ) {
      const contribution = commandRegistry.get(path);
      if (contribution === undefined) {
        return missingTool(
          typeof path === 'string' ? path : path.join(' '),
        ) as ToolTerminal<TResult>;
      }
      return runTool<TResult>(contribution.descriptor.id, args, runOptions);
    },
    run: runTool,
  };
}
