import type { GameProjectPluginEntry } from '@forgeax/engine-project';

export interface RealmCatalogModule {
  readonly name: string;
  readonly realm: 'host' | 'engine' | 'build';
}

export interface RealmCatalogs {
  readonly host: readonly RealmCatalogModule[];
  readonly engine: readonly RealmCatalogModule[];
  readonly build: readonly RealmCatalogModule[];
}

function addModule(
  rows: Map<string, RealmCatalogModule>,
  entry: GameProjectPluginEntry,
  realm: RealmCatalogModule['realm'],
): void {
  if (entry.name.startsWith('cordis:')) return;
  const current = rows.get(entry.name);
  if (current !== undefined && current.realm !== realm) {
    throw new Error(`plugin module ${entry.name} is assigned to multiple realms`);
  }
  rows.set(entry.name, { name: entry.name, realm });
}

function visit(
  entries: readonly GameProjectPluginEntry[],
  inheritedRealm: RealmCatalogModule['realm'],
  rows: Map<string, RealmCatalogModule>,
): void {
  for (const entry of entries) {
    const realm = entry.realm ?? inheritedRealm;
    if (entry.group === true) {
      visit(entry.config as readonly GameProjectPluginEntry[], realm, rows);
      continue;
    }
    addModule(rows, entry, realm);
  }
}

/** Derive all physical Catalog rows from the validated EntryTree once. */
export function deriveRealmCatalogs(entries: readonly GameProjectPluginEntry[]): RealmCatalogs {
  const rows = new Map<string, RealmCatalogModule>();
  visit(entries, 'engine', rows);
  const values = [...rows.values()];
  return {
    host: values.filter((module) => module.realm === 'host'),
    engine: values.filter((module) => module.realm === 'engine'),
    build: values.filter((module) => module.realm === 'build'),
  };
}
