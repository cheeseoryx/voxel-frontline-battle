import { err, ok, type Result } from '@forgeax/engine-types';

export interface AuthorInventoryRow {
  readonly guid: string;
  readonly sourceKey: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly refs: readonly string[];
  readonly sceneBindings?: readonly string[];
}

export interface AuthorInventory {
  readonly declarations: readonly AuthorInventoryRow[];
}

export type InventoryErrorCode =
  | 'inventory-source-key-missing'
  | 'inventory-source-key-duplicate'
  | 'inventory-guid-duplicate'
  | 'inventory-scene-binding-missing'
  | 'inventory-scene-binding-duplicate';

export type InventoryError = {
  readonly code: InventoryErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly guid?: string;
    readonly sourceKey?: string;
  };
};

function failure(
  code: InventoryErrorCode,
  expected: string,
  hint: string,
  detail: InventoryError['detail'],
): Result<never, InventoryError> {
  return err({ code, expected, hint, detail });
}

export function validateAuthorInventory(value: unknown): Result<AuthorInventory, InventoryError> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { readonly declarations?: unknown }).declarations)
  ) {
    return failure(
      'inventory-source-key-missing',
      'an author inventory with declaration rows',
      'declare each author asset in the source inventory',
      {},
    );
  }

  const guids = new Set<string>();
  const sourceKeys = new Set<string>();
  const declarations: AuthorInventoryRow[] = [];
  const rows = (value as { readonly declarations: readonly unknown[] }).declarations;
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) {
      return failure(
        'inventory-source-key-missing',
        'each declaration has a non-empty sourceKey',
        'add sourceKey to the author declaration before projection',
        {},
      );
    }
    const row = raw as Record<string, unknown>;
    const guid = typeof row.guid === 'string' ? row.guid : undefined;
    const sourceKey = typeof row.sourceKey === 'string' ? row.sourceKey : undefined;
    if (
      guid === undefined ||
      sourceKey === undefined ||
      sourceKey.trim().length === 0 ||
      sourceKey !== sourceKey.trim()
    ) {
      return failure(
        'inventory-source-key-missing',
        'each declaration has a non-empty sourceKey',
        'add sourceKey to the author declaration before projection',
        {
          ...(guid === undefined ? {} : { guid }),
          ...(sourceKey === undefined ? {} : { sourceKey }),
        },
      );
    }
    const normalizedGuid = guid.toLowerCase();
    if (guids.has(normalizedGuid)) {
      return failure(
        'inventory-guid-duplicate',
        'every GUID identifies exactly one author declaration',
        'remove or rename the duplicate GUID before publishing the inventory',
        { guid, sourceKey },
      );
    }
    if (sourceKeys.has(sourceKey)) {
      return failure(
        'inventory-source-key-duplicate',
        'every sourceKey identifies exactly one author declaration',
        'rename the duplicate semantic sourceKey before publishing the inventory',
        { guid, sourceKey },
      );
    }
    if (row.kind === 'scene') {
      const payload = row.payload;
      const payloadRecord =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)
          : undefined;
      const entities =
        payloadRecord !== undefined && Array.isArray(payloadRecord.entities)
          ? payloadRecord.entities
          : [];
      const bindings = new Set<string>();
      for (const entity of entities) {
        const bindingKey =
          typeof entity === 'object' && entity !== null && typeof entity.bindingKey === 'string'
            ? entity.bindingKey
            : undefined;
        if (bindingKey !== undefined && bindingKey.length === 0) {
          return failure(
            'inventory-scene-binding-missing',
            'each declared scene bindingKey is non-empty',
            'remove the empty bindingKey or declare a stable key in the scene producer',
            { sourceKey },
          );
        }
        if (bindingKey === undefined) continue;
        if (bindings.has(bindingKey)) {
          return failure(
            'inventory-scene-binding-duplicate',
            'bindingKey values are unique within one scene',
            'rename the duplicate bindingKey in the scene producer',
            { sourceKey },
          );
        }
        bindings.add(bindingKey);
      }
    }
    guids.add(normalizedGuid);
    sourceKeys.add(sourceKey);
    const sceneBindings =
      row.kind === 'scene' && typeof row.payload === 'object' && row.payload !== null
        ? (row.payload as { readonly entities?: readonly unknown[] }).entities?.flatMap(
            (entity) => {
              if (typeof entity !== 'object' || entity === null) return [];
              const key = (entity as { readonly bindingKey?: unknown }).bindingKey;
              return typeof key === 'string' && key.length > 0 ? [key] : [];
            },
          )
        : undefined;
    declarations.push({
      guid,
      sourceKey,
      kind: typeof row.kind === 'string' ? row.kind : 'unknown',
      payload:
        typeof row.payload === 'object' && row.payload !== null
          ? (row.payload as Readonly<Record<string, unknown>>)
          : {},
      refs: Array.isArray(row.refs)
        ? row.refs.filter((ref): ref is string => typeof ref === 'string')
        : [],
      ...(sceneBindings === undefined ? {} : { sceneBindings }),
    });
  }
  return ok({ declarations });
}
