import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';

export type PluginCompositionErrorCode =
  | 'plugin-config-invalid'
  | 'plugin-group-child-failed'
  | 'plugin-group-dependency-cycle'
  | 'plugin-group-key-duplicate'
  | 'plugin-group-key-required'
  | 'plugin-group-provider-missing';

export interface PluginConfigInvalidDetail {
  readonly plugin: string;
}

export interface PluginGroupChildFailedDetail {
  readonly child: string;
}

export interface PluginGroupDependencyCycleDetail {
  readonly path: readonly string[];
}

export interface PluginGroupKeyDuplicateDetail {
  readonly key: string;
}

export interface PluginGroupKeyRequiredDetail {
  readonly plugin: string;
}

export interface PluginGroupProviderMissingDetail {
  readonly service: string;
}

export type PluginCompositionErrorDetailByCode = {
  'plugin-config-invalid': PluginConfigInvalidDetail;
  'plugin-group-child-failed': PluginGroupChildFailedDetail;
  'plugin-group-dependency-cycle': PluginGroupDependencyCycleDetail;
  'plugin-group-key-duplicate': PluginGroupKeyDuplicateDetail;
  'plugin-group-key-required': PluginGroupKeyRequiredDetail;
  'plugin-group-provider-missing': PluginGroupProviderMissingDetail;
};

export type PluginCompositionErrorArgs<
  C extends PluginCompositionErrorCode = PluginCompositionErrorCode,
> = {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PluginCompositionErrorDetailByCode[C];
};

class PluginCompositionErrorClass extends Error {
  readonly code: PluginCompositionErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PluginCompositionErrorDetailByCode[PluginCompositionErrorCode];

  constructor(args: PluginCompositionErrorArgs) {
    super(`${args.code}: ${args.expected}`);
    this.name = 'PluginCompositionError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

type PluginCompositionErrorVariant<C extends PluginCompositionErrorCode> =
  PluginCompositionErrorClass & {
    readonly code: C;
    readonly detail: PluginCompositionErrorDetailByCode[C];
  };

export type PluginCompositionError = {
  [C in PluginCompositionErrorCode]: PluginCompositionErrorVariant<C>;
}[PluginCompositionErrorCode];

interface PluginCompositionErrorConstructor {
  new <C extends PluginCompositionErrorCode>(
    args: PluginCompositionErrorArgs<C>,
  ): PluginCompositionErrorVariant<C>;
  readonly prototype: PluginCompositionError;
}

export const PluginCompositionError: PluginCompositionErrorConstructor =
  PluginCompositionErrorClass as unknown as PluginCompositionErrorConstructor;

export interface PluginUseOptions {
  readonly key?: string;
}

type PluginConfig<P> = P extends (ctx: Context, config: infer C) => unknown
  ? C
  : P extends new (
        ctx: Context,
        config: infer C,
      ) => unknown
    ? C
    : P extends { apply(ctx: Context, config: infer C): unknown }
      ? C
      : unknown;

type ConfigArgs<P> =
  undefined extends PluginConfig<P> ? [config?: PluginConfig<P>] : [config: PluginConfig<P>];

export interface PluginUse<P extends Plugin = Plugin> {
  readonly plugin: P;
  readonly config: PluginConfig<P>;
  readonly key?: string;
}

export function usePlugin<P extends Plugin>(
  plugin: P,
  ...args: [...ConfigArgs<P>, options?: PluginUseOptions]
): PluginUse<P> {
  const config = args[0] as PluginConfig<P>;
  const options = args[1] as PluginUseOptions | undefined;
  return {
    plugin,
    config,
    ...(options?.key === undefined ? {} : { key: options.key }),
  };
}

export interface PluginGroupOptions<C = unknown> {
  readonly name: string;
  readonly children: (config: C) => readonly PluginUse[];
}

interface ChildRecord {
  readonly key: string | object;
  readonly plugin: Plugin;
  config: unknown;
  fiber: Fiber;
}

interface GroupState {
  readonly records: Map<string | object, ChildRecord>;
}

class ChildOperationFailure extends Error {
  constructor(
    readonly child: PluginUse,
    readonly reason: unknown,
    readonly cleanupFailures: readonly unknown[] = [],
  ) {
    super(`child operation failed: ${pluginName(child.plugin)}`);
  }
}

const groupStateKey = Symbol('forgeax.plugin.group.state');

function pluginName(plugin: Plugin): string {
  return plugin.name ?? 'anonymous';
}

function dependencyNames(plugin: Plugin): readonly string[] {
  const inject = plugin.inject;
  if (inject === undefined) return [];
  return Array.isArray(inject) ? inject : Object.keys(inject);
}

function providedNames(plugin: Plugin): readonly string[] {
  const provide = plugin.provide;
  if (provide === undefined) return [];
  return Array.isArray(provide) ? provide : [provide];
}

function keyFor(child: PluginUse): string | object {
  if (child.key !== undefined) return child.key;
  return child.plugin;
}

function validateKeys(children: readonly PluginUse[]): void {
  const keys = new Map<string | object, PluginUse>();
  for (const child of children) {
    const key = keyFor(child);
    const previous = keys.get(key);
    if (previous !== undefined) {
      if (child.key === undefined && previous.key === undefined) {
        throw new PluginCompositionError({
          code: 'plugin-group-key-required',
          expected: 'repeated Plugin references to declare a stable child key',
          hint: 'assign a unique key to each repeated child before activation.',
          detail: { plugin: pluginName(child.plugin) },
        });
      }
      throw new PluginCompositionError({
        code: 'plugin-group-key-duplicate',
        expected: 'stable child key to be unique within its Group',
        hint: 'assign a unique key to each child declaration.',
        detail: { key: String(child.key) },
      });
    }
    keys.set(key, child);
  }
}

function orderedChildren(
  ctx: Context,
  children: readonly PluginUse[],
  groupOwnedServices: ReadonlySet<string>,
): PluginUse[] {
  const providers = new Map<string, number>();
  children.forEach((child, index) => {
    for (const service of providedNames(child.plugin)) {
      if (!providers.has(service)) providers.set(service, index);
    }
  });

  const graph = children.map(() => [] as number[]);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    for (const service of dependencyNames(child.plugin)) {
      const provider = providers.get(service);
      const externalServiceAvailable =
        !groupOwnedServices.has(service) && ctx.reflect.get(service, false) !== undefined;
      if (provider === undefined && !externalServiceAvailable) {
        throw new PluginCompositionError({
          code: 'plugin-group-provider-missing',
          expected: 'an inject/provide dependency to be available before the child starts',
          hint: 'provide the service in the Group or install the owning plugin first.',
          detail: { service },
        });
      }
      if (provider !== undefined && provider !== index) graph[index]?.push(provider);
      if (provider === index) graph[index]?.push(index);
    }
  }

  const state = children.map(() => 0);
  const sorted: number[] = [];
  const visit = (index: number, path: number[]): void => {
    if (state[index] === 1) {
      const cycleStart = path.indexOf(index);
      const cycle = [...path.slice(cycleStart), index].map((item) => {
        const child = children[item];
        return child === undefined ? 'unknown' : pluginName(child.plugin);
      });
      throw new PluginCompositionError({
        code: 'plugin-group-dependency-cycle',
        expected: 'an acyclic inject/provide dependency graph',
        hint: 'break the dependency cycle before activating the Group.',
        detail: { path: cycle },
      });
    }
    if (state[index] === 2) return;
    state[index] = 1;
    for (const dependency of graph[index] ?? []) visit(dependency, [...path, index]);
    state[index] = 2;
    sorted.push(index);
  };
  for (let index = 0; index < children.length; index += 1) visit(index, []);
  return sorted
    .map((index) => children[index])
    .filter((child): child is PluginUse => child !== undefined);
}

async function validateConfig(child: PluginUse): Promise<void> {
  const schema = child.plugin.Config;
  if (schema === undefined) return;
  const result = await schema['~standard'].validate(child.config);
  if ('issues' in result && result.issues) {
    throw new PluginCompositionError({
      code: 'plugin-config-invalid',
      expected: `${pluginName(child.plugin)} Plugin.Config to validate the child config`,
      hint: 'provide a valid config before the child side effect runs.',
      detail: { plugin: pluginName(child.plugin) },
    });
  }
}

async function validateChildren(children: readonly PluginUse[]): Promise<void> {
  const results = await Promise.allSettled(children.map((child) => validateConfig(child)));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure !== undefined) throw failure.reason;
}

function childFailure(child: PluginUse, _reason: unknown): PluginCompositionError {
  return new PluginCompositionError({
    code: 'plugin-group-child-failed',
    expected: `${pluginName(child.plugin)} to activate under its owning Group`,
    hint: 'repair the child and retry the Group update.',
    detail: { child: pluginName(child.plugin) },
  });
}

function sameConfig(left: unknown, right: unknown): boolean {
  return sameDataValue(left, right, new Set());
}

function sameDataValue(left: unknown, right: unknown, active: Set<object>): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) return false;
  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (leftArray) {
    if (leftPrototype !== Array.prototype || rightPrototype !== Array.prototype) return false;
  } else if (
    !(
      (leftPrototype === Object.prototype || leftPrototype === null) &&
      (rightPrototype === Object.prototype || rightPrototype === null) &&
      leftPrototype === rightPrototype
    )
  ) {
    return false;
  }
  if (active.has(left)) return false;
  active.add(left);
  try {
    const leftKeys = Reflect.ownKeys(left).filter((key) => !leftArray || key !== 'length');
    const rightKeys = Reflect.ownKeys(right).filter((key) => !leftArray || key !== 'length');
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key)) return false;
      const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
      const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
      if (
        leftDescriptor === undefined ||
        rightDescriptor === undefined ||
        !('value' in leftDescriptor) ||
        !('value' in rightDescriptor) ||
        !sameDataValue(leftDescriptor.value, rightDescriptor.value, active)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    active.delete(left);
  }
}

function startChild(ctx: Context, child: PluginUse): ChildRecord {
  let fiber: Fiber | undefined;
  try {
    fiber = ctx.plugin(child.plugin, child.config);
    return { key: keyFor(child), plugin: child.plugin, config: child.config, fiber };
  } catch (reason) {
    if (fiber !== undefined) void fiber.dispose();
    if (reason instanceof PluginCompositionError) throw reason;
    throw childFailure(child, reason);
  }
}

async function activateChild(ctx: Context, child: PluginUse): Promise<ChildRecord> {
  const record = startChild(ctx, child);
  await record.fiber.await();
  return record;
}

function recordUse(record: ChildRecord): PluginUse {
  return {
    plugin: record.plugin,
    config: record.config,
    ...(typeof record.key === 'string' ? { key: record.key } : {}),
  };
}

function sharesProvidedService(left: Plugin, right: Plugin): boolean {
  const rightServices = new Set(providedNames(right));
  return providedNames(left).some((service) => rightServices.has(service));
}

async function restoreRecord(
  ctx: Context,
  record: ChildRecord,
  config: unknown,
): Promise<ChildRecord> {
  try {
    await record.fiber.update(config);
    await record.fiber.await();
    return { ...record, config };
  } catch (updateReason) {
    if (record.fiber.uid !== null) await record.fiber.dispose();
    try {
      return await activateChild(ctx, { ...recordUse(record), config });
    } catch (restoreReason) {
      throw restoreReason ?? updateReason;
    }
  }
}

async function settleRecords(
  records: readonly ChildRecord[],
  abort: Promise<unknown> | undefined,
): Promise<void> {
  if (records.length === 0) return;
  const outcomes = records.map((record, index) =>
    record.fiber.await().then(
      () => ({ index, reason: undefined }),
      (reason: unknown) => ({ index, reason }),
    ),
  );
  const pending = new Set(outcomes);
  const abortSignal =
    abort === undefined
      ? undefined
      : abort.then((reason) => ({ index: -1, reason, aborted: true as const }));
  while (pending.size > 0) {
    const outcome = await Promise.race([
      ...pending,
      ...(abortSignal === undefined ? [] : [abortSignal]),
    ]);
    if ('aborted' in outcome) {
      const cleanupFailures = await disposeRecordsInReverse(records);
      await Promise.allSettled(outcomes);
      if (outcome.reason instanceof ChildOperationFailure) {
        throw new ChildOperationFailure(
          outcome.reason.child,
          outcome.reason.reason,
          cleanupFailures,
        );
      }
      throw outcome.reason;
    }
    const completed = outcomes[outcome.index];
    if (completed !== undefined) pending.delete(completed);
    if (outcome.reason !== undefined) {
      const record = records[outcome.index];
      if (record !== undefined) {
        const cleanupFailures = await disposeRecordsInReverse(records);
        await Promise.allSettled(outcomes);
        throw new ChildOperationFailure(recordUse(record), outcome.reason, cleanupFailures);
      }
      throw outcome.reason;
    }
  }
}

async function disposeRecordsInReverse(records: readonly ChildRecord[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const record of [...records].reverse()) {
    try {
      await record.fiber.dispose();
    } catch (reason) {
      failures.push(reason);
    }
  }
  return failures;
}

async function reconcile(
  ctx: Context,
  state: GroupState,
  children: readonly PluginUse[],
): Promise<void> {
  validateKeys(children);
  const groupOwnedServices = new Set<string>();
  for (const record of state.records.values()) {
    for (const service of providedNames(record.plugin)) groupOwnedServices.add(service);
  }
  const ordered = orderedChildren(ctx, children, groupOwnedServices);
  await validateChildren(ordered);
  const desired = new Map(ordered.map((child) => [keyFor(child), child] as const));
  const removed = [...state.records.values()].filter((record) => !desired.has(record.key));
  const changed: Array<{ record: ChildRecord; child: PluginUse; config: unknown }> = [];
  const candidateChildren: PluginUse[] = [];
  const replacements: Array<{ old: ChildRecord; child: PluginUse }> = [];
  const released: ChildRecord[] = [];
  const retired: ChildRecord[] = [];
  const candidates: ChildRecord[] = [];

  for (const child of ordered) {
    const current = state.records.get(keyFor(child));
    if (current === undefined) {
      candidateChildren.push(child);
    } else if (current.plugin !== child.plugin) {
      candidateChildren.push(child);
      replacements.push({ old: current, child });
    } else if (!sameConfig(current.config, child.config)) {
      changed.push({ record: current, child, config: current.config });
    }
  }

  const desiredServiceProviders = candidateChildren.filter(
    (child) => providedNames(child.plugin).length > 0,
  );
  for (const record of removed) {
    if (
      desiredServiceProviders.some((child) => sharesProvidedService(record.plugin, child.plugin))
    ) {
      released.push(record);
    }
  }
  for (const { old, child } of replacements) {
    if (sharesProvidedService(old.plugin, child.plugin) && !released.includes(old)) {
      released.push(old);
    }
  }

  try {
    const releaseResults = await Promise.allSettled(
      released.map((record) => record.fiber.dispose()),
    );
    const releaseFailureIndex = releaseResults.findIndex(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (releaseFailureIndex !== -1) {
      const releaseFailure = releaseResults[releaseFailureIndex];
      const releasedRecord = released[releaseFailureIndex];
      if (releaseFailure?.status === 'rejected' && releasedRecord !== undefined) {
        throw new ChildOperationFailure(recordUse(releasedRecord), releaseFailure.reason);
      }
      throw releaseFailure;
    }

    const updateTasks = changed.map(({ record, child }) => {
      return Promise.resolve()
        .then(() => record.fiber.update(child.config))
        .then(() => record.fiber.await())
        .catch((reason: unknown) => {
          throw new ChildOperationFailure(child, reason);
        });
    });
    for (const child of candidateChildren) candidates.push(startChild(ctx, child));
    const updateFailure =
      updateTasks.length === 0
        ? undefined
        : Promise.race(
            updateTasks.map((task) =>
              task.then(
                () => new Promise<never>(() => {}),
                (reason: unknown) => reason,
              ),
            ),
          );
    const results = await Promise.allSettled([
      settleRecords(candidates, updateFailure),
      ...updateTasks,
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
    for (const record of removed) {
      if (released.includes(record)) continue;
      retired.push(record);
      try {
        await record.fiber.dispose();
      } catch (retirementReason) {
        throw new ChildOperationFailure(recordUse(record), retirementReason);
      }
    }
    for (const { old } of replacements) {
      if (released.includes(old)) continue;
      retired.push(old);
      try {
        await old.fiber.dispose();
      } catch (retirementReason) {
        throw new ChildOperationFailure(recordUse(old), retirementReason);
      }
    }
  } catch (reason) {
    const operation = reason instanceof ChildOperationFailure ? reason : undefined;
    const primary = operation?.reason ?? reason;
    const rollbackFailures = operation?.cleanupFailures
      ? [...operation.cleanupFailures]
      : await disposeRecordsInReverse(candidates);
    for (const { record, config } of changed.reverse()) {
      try {
        const restored = await restoreRecord(ctx, record, config);
        state.records.set(record.key, restored);
      } catch (restoreReason) {
        rollbackFailures.push(restoreReason);
      }
    }
    for (const record of released.reverse()) {
      try {
        const restored = await activateChild(ctx, recordUse(record));
        state.records.set(record.key, restored);
      } catch (restoreReason) {
        rollbackFailures.push(restoreReason);
      }
    }
    for (const record of retired.reverse()) {
      try {
        const restored = await activateChild(ctx, recordUse(record));
        state.records.set(record.key, restored);
      } catch (restoreReason) {
        rollbackFailures.push(restoreReason);
      }
    }
    const fallback = operation?.child ?? ordered[0];
    const primaryError =
      primary instanceof PluginCompositionError
        ? primary
        : fallback === undefined
          ? primary
          : childFailure(fallback, primary);
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [primaryError, ...rollbackFailures],
        'plugin Group reconciliation and rollback both failed',
      );
    }
    throw primaryError;
  }

  for (const record of removed) state.records.delete(record.key);
  for (const { old, child } of replacements) {
    state.records.delete(old.key);
    const next = candidates.find((record) => record.key === keyFor(child));
    if (next !== undefined) state.records.set(next.key, next);
  }
  for (const record of candidates) state.records.set(record.key, record);
  for (const { record, child } of changed) record.config = child.config;
}

export function definePluginGroup<C = unknown>(options: PluginGroupOptions<C>): Plugin {
  const group: Plugin.Object = {
    name: options.name,
    async apply(ctx, config) {
      const owner = ctx.fiber as Fiber & { [groupStateKey]?: GroupState };
      let state = owner[groupStateKey];
      if (state === undefined) {
        state = { records: new Map() };
        owner[groupStateKey] = state;
      }
      ctx.effect(
        () => async () => {
          state.records.clear();
          delete owner[groupStateKey];
        },
        'plugin-group-state',
      );
      ctx.on('internal/update', (nextConfig, _noSave, _next) =>
        reconcile(ctx, state, options.children(nextConfig as C)),
      );
      await reconcile(ctx, state, options.children(config as C));
    },
  };
  return group;
}
