import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  isToolCommandContract,
  type ToolCommandContract,
  type ToolCommandDeclaration,
} from '@forgeax/engine-plugin';
import type { PluginRealm } from '@forgeax/engine-plugin/loader';
import { type GameProjectPluginEntry, GameProjectSchema } from '@forgeax/engine-project';
import {
  createToolRuntime,
  type JsonValue,
  type ToolContribution,
  type ToolDomainFailure,
  type ToolExecutor,
  type ToolJsonSchema,
  type ToolRunOptions,
  type ToolTerminal,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import { createServer, type ViteDevServer } from 'vite';
import { commandPathForToolId } from './catalog.js';

export interface ProjectToolBinding {
  readonly contribution: ToolContribution<unknown, unknown>;
  readonly entry: GameProjectPluginEntry;
  readonly moduleName: string;
  readonly realm: PluginRealm;
  /** Executor loading is deliberately delayed until this command is invoked. */
  readonly loadExecutor: () => Promise<ToolExecutor<unknown, unknown>>;
}

export interface ProjectToolModuleLoader {
  readonly load: (name: string) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export interface ProjectToolDiscoveryOptions {
  readonly moduleLoader?: ProjectToolModuleLoader;
}

interface ProjectPluginLeaf {
  readonly entry: GameProjectPluginEntry;
  readonly moduleName: string;
  readonly realm: PluginRealm;
}

function projectLeaves(
  entries: readonly GameProjectPluginEntry[],
  inheritedRealm: PluginRealm = 'engine',
): ProjectPluginLeaf[] {
  const leaves: ProjectPluginLeaf[] = [];
  for (const entry of entries) {
    const realm = entry.realm ?? inheritedRealm;
    if (entry.disabled === true) continue;
    if (entry.group === true) {
      leaves.push(...projectLeaves(entry.config as readonly GameProjectPluginEntry[], realm));
      continue;
    }
    if (entry.commandContract !== undefined) {
      leaves.push({ entry, moduleName: entry.commandContract, realm });
    }
  }
  return leaves;
}

function parseSchema(value: string | undefined): ToolJsonSchema | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('command schema must be a JSON object');
  }
  return parsed as ToolJsonSchema;
}

function contractFromModule(module: unknown, entry: GameProjectPluginEntry): ToolCommandContract {
  const candidates = [
    module,
    module !== null && typeof module === 'object' ? Reflect.get(module, 'default') : undefined,
    module !== null && typeof module === 'object' ? Reflect.get(module, 'contract') : undefined,
    module !== null && typeof module === 'object'
      ? Reflect.get(module, 'toolCommandContract')
      : undefined,
  ];
  const contract = candidates.find(isToolCommandContract);
  if (contract === undefined) {
    throw new TypeError(`Entry ${entry.id} does not export a valid ToolCommandContract`);
  }
  return contract;
}

function staticDescriptor(
  declaration: ToolCommandDeclaration,
  realm: PluginRealm,
): ToolContribution<unknown, unknown> {
  if (declaration.realm !== realm) {
    throw new TypeError(
      `Tool ${declaration.id} declares ${declaration.realm} but Entry owns ${realm}`,
    );
  }
  const inputSchema = parseSchema(declaration.argsSchema);
  const outputSchema = parseSchema(declaration.resultSchema);
  const unavailable: ToolExecutor<unknown, unknown> = async () => ({
    ok: false,
    error: {
      code: 'tool-capability-unavailable',
      expected: `executor for ${declaration.id} to be loaded at invocation`,
      hint: 'Repair the project command executor or invoke it after the project host is ready.',
      detail: { capability: `tool:${declaration.id}`, realm },
    } satisfies ToolDomainFailure,
  });
  return {
    descriptor: {
      id: declaration.id,
      path: declaration.path ?? commandPathForToolId(declaration.id),
      title: declaration.title,
      summary: declaration.summary,
      realm,
      argsSchema:
        inputSchema === undefined
          ? { parse: (value) => ({ ok: true, value }) }
          : toolJsonSchema(inputSchema),
      resultSchema:
        outputSchema === undefined
          ? { parse: (value) => ({ ok: true, value }) }
          : toolJsonSchema(outputSchema),
      evidence: declaration.evidence ?? [],
      ...(inputSchema === undefined ? {} : { inputSchema: inputSchema as unknown as JsonValue }),
      ...(outputSchema === undefined ? {} : { outputSchema: outputSchema as unknown as JsonValue }),
    },
    execute: unavailable,
  };
}

function executorFromModule(
  module: unknown,
  declaration: ToolCommandDeclaration,
): ToolExecutor<unknown, unknown> {
  const candidate =
    declaration.exportName !== undefined && module !== null && typeof module === 'object'
      ? Reflect.get(module, declaration.exportName)
      : module !== null && typeof module === 'object'
        ? (Reflect.get(module, 'execute') ?? Reflect.get(module, 'default'))
        : module;
  if (typeof candidate !== 'function') {
    throw new TypeError(`Executor for ${declaration.id} must export a function`);
  }
  return candidate as ToolExecutor<unknown, unknown>;
}

async function createViteModuleLoader(root: string): Promise<ProjectToolModuleLoader> {
  const server: ViteDevServer = await createServer({
    root,
    appType: 'custom',
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  return {
    load(name) {
      const id = name.startsWith('.') ? `/@fs/${resolve(root, name)}` : name;
      return server.ssrLoadModule(id);
    },
    close: () => server.close(),
  };
}

async function readProjectEntries(root: string): Promise<readonly GameProjectPluginEntry[]> {
  try {
    await access(resolve(root, 'forge.json'));
  } catch (cause) {
    if (
      cause === null ||
      typeof cause !== 'object' ||
      !('code' in cause) ||
      cause.code !== 'ENOENT'
    ) {
      throw cause;
    }
    return [];
  }
  const raw = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as unknown;
  const parsed = GameProjectSchema.safeParse(raw);
  if (!parsed.success) throw new TypeError(`Invalid forge.json: ${parsed.error.message}`);
  return parsed.data.plugins ?? [];
}

export async function discoverProjectTools(
  rootInput: string,
  options: ProjectToolDiscoveryOptions = {},
): Promise<readonly ProjectToolBinding[]> {
  const root = resolve(rootInput);
  const loader = options.moduleLoader ?? (await createViteModuleLoader(root));
  const ownsLoader = options.moduleLoader === undefined;
  try {
    const bindings: ProjectToolBinding[] = [];
    const ids = new Map<string, string>();
    for (const leaf of projectLeaves(await readProjectEntries(root))) {
      // Discovery evaluates only the pure contract module. Its executor path is
      // retained as data and is imported by loadExecutor on the execute path.
      const contract = contractFromModule(await loader.load(leaf.moduleName), leaf.entry);
      for (const declaration of contract.commands) {
        const contribution = staticDescriptor(declaration, leaf.realm);
        const existing = ids.get(declaration.id);
        if (existing !== undefined) {
          throw new TypeError(
            `Duplicate project tool id ${declaration.id} from ${existing} and ${leaf.entry.id}`,
          );
        }
        ids.set(declaration.id, leaf.entry.id);
        bindings.push({
          contribution,
          entry: leaf.entry,
          moduleName: leaf.moduleName,
          realm: leaf.realm,
          loadExecutor: async () => {
            if (declaration.executor === undefined) {
              throw new TypeError(`Command ${declaration.id} has no executor module`);
            }
            const executionLoader = options.moduleLoader ?? (await createViteModuleLoader(root));
            const closesLoader = options.moduleLoader === undefined;
            const executorName = declaration.executor.startsWith('.')
              ? `/@fs/${resolve(root, dirname(leaf.moduleName), declaration.executor)}`
              : declaration.executor;
            try {
              return executorFromModule(await executionLoader.load(executorName), declaration);
            } finally {
              if (closesLoader) await executionLoader.close();
            }
          },
        });
      }
    }
    return bindings;
  } finally {
    if (ownsLoader) await loader.close();
  }
}

function activationFailure(cause: unknown): ToolTerminal<never> {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    outcome: 'failed',
    failure: {
      code: 'tool-domain-failed',
      expected: 'the project command executor to load and finish',
      hint: 'Repair the command contract or executor module before retrying.',
      detail: { code: 'tool-command-execution-failed', payload: message },
    },
    artifacts: [],
  };
}

export async function runProjectTool(
  binding: ProjectToolBinding,
  args: unknown,
  options: ToolRunOptions,
): Promise<ToolTerminal<unknown>> {
  try {
    const contribution = { ...binding.contribution, execute: await binding.loadExecutor() };
    return createToolRuntime([contribution]).run(contribution, args, options).terminal;
  } catch (cause) {
    return activationFailure(cause);
  }
}
