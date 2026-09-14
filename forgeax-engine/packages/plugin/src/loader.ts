import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';
import { type EntryOptions, Group, Loader } from '@deepseek-ai/cordis-plugin-loader';
import type { ToolRealm } from '@forgeax/engine-tool-runtime';

import { isToolPlugin } from './tool-plugin.js';

export type PluginRealm = ToolRealm;

export interface PluginCatalogRecord {
  readonly realm: PluginRealm;
  /** Package code identity bound by a generated/static catalog. */
  readonly version?: string;
  /** Optional content identity for catalogs that pin source bytes. */
  readonly digest?: string;
  readonly load: () => Promise<unknown>;
}

export type PluginCatalog = ReadonlyMap<string, PluginCatalogRecord>;

export { createContextCapabilityResolver } from './capability.js';
export { defineToolPlugin, isToolPlugin, type ToolPlugin } from './tool-plugin.js';

export interface GamePluginEntry extends EntryOptions {
  readonly realm?: PluginRealm;
}

export type CatalogLoaderErrorCode =
  | 'plugin-catalog-missing'
  | 'plugin-realm-mismatch'
  | 'plugin-entry-realm-mixed'
  | 'plugin-realm-unsupported'
  | 'plugin-catalog-digest-mismatch';

export interface CatalogMissingDetail {
  readonly name: string;
  readonly realm?: PluginRealm;
  readonly attempt?: number;
}

export interface CatalogRealmMismatchDetail {
  readonly name: string;
  readonly actual: PluginRealm;
  readonly expected: PluginRealm;
}

export interface CatalogMixedRealmDetail {
  readonly group: string;
  readonly actual: PluginRealm;
  readonly expected: PluginRealm;
}

export interface CatalogUnsupportedRealmDetail {
  readonly realm: PluginRealm;
  readonly supportedRealms: readonly PluginRealm[];
}

export interface CatalogDigestMismatchDetail {
  readonly actual: string;
  readonly expected: string;
}

export type CatalogLoaderErrorDetailByCode = {
  'plugin-catalog-missing': CatalogMissingDetail;
  'plugin-realm-mismatch': CatalogRealmMismatchDetail;
  'plugin-entry-realm-mixed': CatalogMixedRealmDetail;
  'plugin-realm-unsupported': CatalogUnsupportedRealmDetail;
  'plugin-catalog-digest-mismatch': CatalogDigestMismatchDetail;
};

export type CatalogLoaderErrorArgs<C extends CatalogLoaderErrorCode = CatalogLoaderErrorCode> = {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: CatalogLoaderErrorDetailByCode[C];
};

class CatalogLoaderErrorClass extends Error {
  readonly code: CatalogLoaderErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: CatalogLoaderErrorDetailByCode[CatalogLoaderErrorCode];

  constructor(args: CatalogLoaderErrorArgs) {
    super(`${args.code}: ${args.expected}`);
    this.name = 'CatalogLoaderError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

type CatalogLoaderErrorVariant<C extends CatalogLoaderErrorCode> = CatalogLoaderErrorClass & {
  readonly code: C;
  readonly detail: CatalogLoaderErrorDetailByCode[C];
};

export type CatalogLoaderError = {
  [C in CatalogLoaderErrorCode]: CatalogLoaderErrorVariant<C>;
}[CatalogLoaderErrorCode];

interface CatalogLoaderErrorConstructor {
  new <C extends CatalogLoaderErrorCode>(
    code: C,
    expected: string,
    hint: string,
    detail: CatalogLoaderErrorDetailByCode[C],
  ): CatalogLoaderErrorVariant<C>;
  readonly prototype: CatalogLoaderError;
}

export const CatalogLoaderError: CatalogLoaderErrorConstructor =
  class extends CatalogLoaderErrorClass {
    constructor(
      code: CatalogLoaderErrorCode,
      expected: string,
      hint: string,
      detail: CatalogLoaderErrorDetailByCode[CatalogLoaderErrorCode],
    ) {
      super({ code, expected, hint, detail });
    }
  } as unknown as CatalogLoaderErrorConstructor;

interface CatalogLoaderConfig {
  readonly catalog: PluginCatalog;
  readonly realm: PluginRealm;
  readonly baseUrl?: string;
}

export interface CatalogLoaderBootstrapOptions {
  readonly catalogDigest: string;
  readonly supportedRealms: readonly PluginRealm[];
}

export interface CatalogLoaderBootstrapValue extends CatalogLoaderHandle {
  readonly catalogDigest: string;
  readonly realm: PluginRealm;
}

export type CatalogLoaderBootstrapResult =
  | { readonly ok: true; readonly value: CatalogLoaderBootstrapValue }
  | { readonly ok: false; readonly error: CatalogLoaderError };

/** DeepSeek Harness Loader with its import boundary resolved by a static build catalog. */
export class CatalogLoader extends Loader {
  readonly catalog: PluginCatalog;
  readonly realm: PluginRealm;

  constructor(ctx: Context, config: CatalogLoaderConfig) {
    super(ctx, config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl });
    this.catalog = config.catalog;
    this.realm = config.realm;
    this.internal = undefined;
    this.builtins.group = Group;
  }

  override import(name: string, getOuterStack?: () => string[]): Promise<unknown> | unknown {
    if (name.startsWith('cordis:')) return super.import(name, getOuterStack);
    const record = this.catalog.get(name);
    if (record === undefined) {
      throw new CatalogLoaderError(
        'plugin-catalog-missing',
        `plugin ${name} to exist in the generated catalog`,
        'Install the package, add the Entry to forge.json, and rebuild the generated catalog.',
        { name, realm: this.realm },
      );
    }
    if (record.realm !== this.realm) {
      throw new CatalogLoaderError(
        'plugin-realm-mismatch',
        `plugin ${name} to target the ${this.realm} realm`,
        'Use a realm-specific plugin export and Entry.',
        { actual: record.realm, expected: this.realm, name },
      );
    }
    return record.load();
  }

  override unwrapExports(exports: unknown): unknown {
    const value = super.unwrapExports(exports);
    return isToolPlugin(value) ? value.plugin : value;
  }
}

export interface CatalogLoaderHandle {
  readonly loader: CatalogLoader;
  readonly fiber: Fiber;
}

/** Bridges one already-active Cordis realm into the generic typed capability seam. */
/** Install the native DSH Loader service into an existing Cordis realm. */
export async function installCatalogLoader(
  ctx: Context,
  catalog: PluginCatalog,
  realm: PluginRealm,
): Promise<CatalogLoaderHandle> {
  const fiber = await ctx.plugin(CatalogLoader as unknown as Plugin, { catalog, realm });
  return { fiber, loader: ctx.loader as CatalogLoader };
}

/** Validate the physical realm before installing the one native CatalogLoader. */
export async function bootstrapCatalogLoader(
  ctx: Context,
  catalog: PluginCatalog,
  realm: PluginRealm,
  options: CatalogLoaderBootstrapOptions,
): Promise<CatalogLoaderBootstrapResult> {
  if (!options.supportedRealms.includes(realm)) {
    return {
      ok: false,
      error: new CatalogLoaderError(
        'plugin-realm-unsupported',
        `the ${realm} realm to be supported by this host`,
        'Select a realm advertised by the capability matrix before module evaluation.',
        { realm, supportedRealms: options.supportedRealms },
      ),
    };
  }
  const handle = await installCatalogLoader(ctx, catalog, realm);
  return {
    ok: true,
    value: { ...handle, catalogDigest: options.catalogDigest, realm },
  };
}

function effectiveRealm(entry: GamePluginEntry, inherited: PluginRealm): PluginRealm {
  return entry.realm ?? inherited;
}

function assertSingleRealmGroup(entry: GamePluginEntry, inheritedRealm: PluginRealm): void {
  const realm = effectiveRealm(entry, inheritedRealm);
  if (!entry.group) return;
  const children = (entry.config ?? []) as readonly GamePluginEntry[];
  for (const child of children) {
    const childRealm = effectiveRealm(child, realm);
    if (childRealm !== realm) {
      throw new CatalogLoaderError(
        'plugin-entry-realm-mixed',
        `group ${entry.id} to contain entries for only the ${realm} physical realm`,
        'Split Host and Engine capabilities into separate top-level groups.',
        { actual: childRealm, expected: realm, group: entry.id },
      );
    }
    assertSingleRealmGroup(child, realm);
  }
}

function projectEntry(entry: GamePluginEntry, inherited: PluginRealm): EntryOptions {
  const realm = effectiveRealm(entry, inherited);
  const config = entry.group
    ? projectPluginEntries((entry.config ?? []) as readonly GamePluginEntry[], realm, realm)
    : entry.config;
  return {
    id: entry.id,
    name: entry.name,
    ...(config === undefined ? {} : { config }),
    ...(entry.group == null ? {} : { group: entry.group }),
    ...(entry.disabled == null ? {} : { disabled: entry.disabled }),
    ...(entry.inject == null ? {} : { inject: entry.inject }),
  };
}

/** Select one physical realm and strip ForgeaX-only deployment metadata before DSH reconciliation. */
export function projectPluginEntries(
  entries: readonly GamePluginEntry[],
  realm: PluginRealm,
  inheritedRealm: PluginRealm = 'engine',
): EntryOptions[] {
  const projected: EntryOptions[] = [];
  for (const entry of entries) {
    const current = effectiveRealm(entry, inheritedRealm);
    assertSingleRealmGroup(entry, inheritedRealm);
    if (current === realm) projected.push(projectEntry(entry, current));
  }
  return projected;
}

export {
  Entry,
  EntryGroup,
  type EntryOptions,
  EntryTree,
  Group,
  Loader,
} from '@deepseek-ai/cordis-plugin-loader';
