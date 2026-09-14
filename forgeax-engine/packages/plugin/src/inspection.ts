import type { CatalogLoader, Entry, EntryOptions } from './loader.js';

export type CatalogPluginFiberState =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | 'disabled'
  | 'missing'
  | 'unavailable';

export interface CatalogPluginInspectionFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface CatalogPluginInspectionEntry extends EntryOptions {
  readonly entryId: string;
  readonly module: string;
  readonly realm: 'host' | 'engine' | 'build';
  readonly desiredState: 'enabled' | 'disabled';
  readonly fiberState: CatalogPluginFiberState;
  readonly parent?: string;
  readonly requiredServices: readonly string[];
  readonly providedServices: readonly string[];
  readonly configDigest: string;
  readonly failure?: CatalogPluginInspectionFailure;
}

export interface CatalogPluginInspection {
  readonly live: readonly CatalogPluginInspectionEntry[];
}

const FIBER_STATE_BY_CODE: readonly CatalogPluginFiberState[] = [
  'pending',
  'loading',
  'active',
  'failed',
  'disposed',
  'unloading',
];

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function configDigest(value: unknown): string {
  let hash = 2166136261;
  for (const char of canonicalJson(value)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function requiredServices(inject: unknown): readonly string[] {
  if (Array.isArray(inject)) {
    return inject.filter((name): name is string => typeof name === 'string').sort();
  }
  if (inject !== null && typeof inject === 'object') return Object.keys(inject).sort();
  return [];
}

function providedServices(fiber: NonNullable<Entry['fiber']>): readonly string[] {
  const names = new Set<string>();
  const stores = [
    fiber.store,
    (fiber.ctx.reflect as unknown as { readonly store?: Record<PropertyKey, unknown> }).store,
  ];
  for (const store of stores) {
    if (store === undefined) continue;
    for (const key of Reflect.ownKeys(store)) {
      const value = (store as Record<PropertyKey, unknown>)[key];
      if (
        value !== null &&
        typeof value === 'object' &&
        'fiber' in value &&
        ((value as { readonly fiber?: { readonly uid?: unknown } }).fiber === fiber ||
          (value as { readonly fiber?: { readonly uid?: unknown } }).fiber?.uid === fiber.uid) &&
        'name' in value &&
        typeof (value as { readonly name?: unknown }).name === 'string'
      ) {
        names.add((value as { readonly name: string }).name);
      }
    }
  }
  return [...names].sort();
}

function failureFromFiber(
  fiber: NonNullable<Entry['fiber']>,
): CatalogPluginInspectionFailure | undefined {
  if (fiber.state !== 3) return undefined;
  const cause = (fiber as unknown as { readonly _error?: unknown })._error;
  if (
    cause !== null &&
    typeof cause === 'object' &&
    typeof (cause as { readonly code?: unknown }).code === 'string' &&
    typeof (cause as { readonly expected?: unknown }).expected === 'string' &&
    typeof (cause as { readonly hint?: unknown }).hint === 'string' &&
    (cause as { readonly detail?: unknown }).detail !== null &&
    typeof (cause as { readonly detail?: unknown }).detail === 'object'
  ) {
    return {
      code: (cause as { readonly code: string }).code,
      expected: (cause as { readonly expected: string }).expected,
      hint: (cause as { readonly hint: string }).hint,
      detail: (cause as { readonly detail: Readonly<Record<string, unknown>> }).detail,
    };
  }
  return {
    code: 'plugin-fiber-failed',
    expected: 'the native Plugin Fiber to settle in an active state',
    hint: 'Read the owning Entry, repair its module/config or required service, then reconcile again.',
    detail: {
      reason: cause instanceof Error ? cause.message : String(cause ?? 'unknown failure'),
    },
  };
}

function projectLiveEntry(loader: CatalogLoader, entry: Entry): CatalogPluginInspectionEntry {
  const options = entry.options;
  const fiber = entry.fiber;
  const disabled = entry.disabled;
  const state = disabled
    ? 'disabled'
    : fiber === undefined
      ? 'missing'
      : (FIBER_STATE_BY_CODE[fiber.state] ?? 'unavailable');
  const parent = entry.parent?.ctx.fiber.entry?.id;
  const failure = fiber === undefined ? undefined : failureFromFiber(fiber);
  return {
    ...options,
    entryId: entry.id,
    module: options.name,
    realm: loader.realm,
    desiredState: disabled ? 'disabled' : 'enabled',
    fiberState: state,
    ...(parent === undefined ? {} : { parent }),
    requiredServices: requiredServices(fiber?.inject ?? options.inject),
    providedServices: fiber === undefined ? [] : providedServices(fiber),
    configDigest: configDigest(options.config),
    ...(failure === undefined ? {} : { failure }),
  };
}

/** Project the live native Loader tree without introducing another state owner. */
export function inspectCatalogPlugins(loader: CatalogLoader): CatalogPluginInspection {
  return { live: [...loader.entries()].map((entry) => projectLiveEntry(loader, entry)) };
}
