import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type GameProjectPluginEntry, GameProjectSchema } from '@forgeax/engine-project';
import type { CommandError, CommandResult, ProjectFacts } from './types.js';

function projectError(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): CommandResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function firstUnsupportedStandaloneRealm(
  entries: readonly GameProjectPluginEntry[],
  inheritedRealm: GameProjectPluginEntry['realm'] = 'engine',
): { readonly id: string; readonly realm: 'host' | 'build' } | undefined {
  for (const entry of entries) {
    const realm = entry.realm ?? inheritedRealm ?? 'engine';
    if (realm !== 'engine') return { id: entry.id, realm };
    if (entry.group === true) {
      const unsupported = firstUnsupportedStandaloneRealm(
        entry.config as readonly GameProjectPluginEntry[],
        realm,
      );
      if (unsupported !== undefined) return unsupported;
    }
  }
  return undefined;
}

function pluginModuleNames(entries: readonly GameProjectPluginEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.group === true
      ? pluginModuleNames(entry.config as readonly GameProjectPluginEntry[])
      : [entry.name],
  );
}

export async function readProjectFacts(
  rootInput = process.cwd(),
): Promise<CommandResult<ProjectFacts>> {
  const root = resolve(rootInput);
  let forgeValue: unknown;
  let packageValue: unknown;
  try {
    [forgeValue, packageValue] = await Promise.all([
      readJson(resolve(root, 'forge.json')),
      readJson(resolve(root, 'package.json')),
    ]);
  } catch (cause) {
    return projectError(
      'project-manifest-unreadable',
      'readable forge.json and package.json files',
      'Run the command from a ForgeaX game root or pass its directory.',
      { root, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (forgeValue === null || typeof forgeValue !== 'object') {
    return projectError(
      'project-manifest-invalid',
      'forge.json to contain an object',
      'Repair forge.json before running DevKit.',
      { root },
    );
  }
  if (packageValue === null || typeof packageValue !== 'object') {
    return projectError(
      'package-manifest-invalid',
      'package.json to contain an object',
      'Repair package.json before running DevKit.',
      { root },
    );
  }
  const parsedForge = GameProjectSchema.safeParse(forgeValue);
  if (!parsedForge.success) {
    return projectError(
      'project-manifest-invalid',
      'forge.json to satisfy @forgeax/engine-project GameProjectSchema',
      'Repair the fields reported by the authoritative project schema.',
      { root, issues: parsedForge.error.issues },
    );
  }
  const forge = parsedForge.data;
  if (forge.id.length === 0 || forge.name.length === 0) {
    return projectError(
      'project-manifest-invalid',
      'forge.json to declare id and name',
      'Restore the project identity in the authoritative project manifest.',
      { root },
    );
  }
  const plugins = forge.plugins ?? [];
  const unsupportedRealm = firstUnsupportedStandaloneRealm(plugins);
  if (unsupportedRealm !== undefined) {
    return projectError(
      'project-plugin-realm-unsupported',
      'the standalone Devkit host to contain only engine-realm plugin Entries',
      'Move Host or build plugins to a host that owns that physical realm.',
      { root, ...unsupportedRealm },
    );
  }
  const packageJson = packageValue as Record<string, unknown>;
  const pluginModules = pluginModuleNames(plugins);
  for (const name of pluginModules) {
    if (!name.startsWith('.')) continue;
    try {
      await readFile(resolve(root, name));
    } catch {
      return projectError(
        'project-plugin-missing',
        'each local forge.json plugin module to resolve to a readable file',
        'Restore the plugin module or update its Entry name in forge.json#plugins.',
        { root, plugin: name },
      );
    }
  }
  const defaultScene =
    typeof forge.defaultScene === 'string' && forge.defaultScene.length > 0
      ? forge.defaultScene
      : undefined;
  return {
    ok: true,
    value: {
      root,
      id: forge.id,
      name: forge.name,
      plugins,
      ...(defaultScene === undefined ? {} : { defaultScene }),
      assetRoots: ['assets'],
      packageJson,
    },
  };
}

export function commandError(cause: unknown, fallbackCode: string): CommandError {
  if (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    'expected' in cause &&
    'hint' in cause &&
    'detail' in cause
  ) {
    return cause as CommandError;
  }
  return {
    code: fallbackCode,
    expected: 'the ForgeaX command to complete',
    hint: 'Inspect the underlying diagnostic and repair the owning input.',
    detail: { reason: cause instanceof Error ? cause.message : String(cause) },
  };
}
