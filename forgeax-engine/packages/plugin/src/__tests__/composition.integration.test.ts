import { Context, type Plugin } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import {
  bootstrapCatalogLoader,
  CatalogLoaderError,
  definePluginGroup,
  installCatalogLoader,
  PluginCompositionError,
  projectPluginEntries,
  usePlugin,
} from '../index.js';

function assertCatalogFailure(
  error: unknown,
  code: CatalogLoaderError['code'],
  subject: string,
  expectedOwner: string,
  recoveryAction: string,
): CatalogLoaderError {
  expect(error).toBeInstanceOf(CatalogLoaderError);
  if (!(error instanceof CatalogLoaderError)) throw new Error('expected CatalogLoaderError');
  const failure = error;
  expect(failure.code).toBe(code);
  expect(failure.expected).toContain(expectedOwner);
  expect(failure.hint).toContain(recoveryAction);
  switch (failure.code) {
    case 'plugin-catalog-missing':
      expect(failure.detail.name).toBe(subject);
      break;
    case 'plugin-realm-mismatch':
      expect(failure.detail.name).toBe(subject);
      expect(failure.detail.actual).toBe('host');
      expect(failure.detail.expected).toBe('engine');
      break;
    case 'plugin-entry-realm-mixed':
      expect(failure.detail.group).toBe(subject);
      expect(failure.detail.expected).toBe('engine');
      break;
    case 'plugin-realm-unsupported':
      expect(failure.detail.realm).toBe(subject);
      break;
    case 'plugin-catalog-digest-mismatch':
      expect(failure.detail.actual).toBe(subject);
      break;
  }
  return failure;
}

function assertCompositionFailure(
  error: unknown,
  code: PluginCompositionError['code'],
  subject: string,
  expectedOwner: string,
  recoveryAction: string,
): void {
  expect(error).toBeInstanceOf(PluginCompositionError);
  if (!(error instanceof PluginCompositionError))
    throw new Error('expected PluginCompositionError');
  const failure = error;
  expect(failure.code).toBe(code);
  expect(failure.expected).toContain(expectedOwner);
  expect(failure.hint).toContain(recoveryAction);
  switch (failure.code) {
    case 'plugin-config-invalid':
      expect(failure.detail.plugin).toBe(subject);
      break;
    case 'plugin-group-child-failed':
      expect(failure.detail.child).toBe(subject);
      break;
    case 'plugin-group-dependency-cycle':
      expect(failure.detail.path).toEqual(expect.arrayContaining([subject]));
      break;
    case 'plugin-group-key-duplicate':
      expect(failure.detail.key).toBe(subject);
      break;
    case 'plugin-group-key-required':
      expect(failure.detail.plugin).toBe(subject);
      break;
    case 'plugin-group-provider-missing':
      expect(failure.detail.service).toBe(subject);
      break;
  }
}

describe('definePluginGroup', () => {
  it('passes the provider-owned service value to an injected consumer', async () => {
    const observed: number[] = [];
    const provider: Plugin = {
      name: 'answer-provider',
      provide: 'answer',
      apply(ctx) {
        ctx.provide('answer', 42);
      },
    };
    const consumer: Plugin = {
      name: 'answer-consumer',
      inject: ['answer'],
      apply(ctx) {
        observed.push((ctx as Context & { readonly answer: number }).answer);
      },
    };
    const group = definePluginGroup({
      name: 'provider-value-group',
      children: () => [usePlugin(consumer), usePlugin(provider)],
    });
    const ctx = new Context();

    await ctx.plugin(group);
    expect(observed).toEqual([42]);
    await ctx.fiber.dispose();
  });

  it('keeps the old child as LKG until a replacement child settles', async () => {
    const events: string[] = [];
    let failReplacement = true;
    const oldProvider: Plugin = {
      name: 'old-provider',
      provide: 'answer',
      apply(ctx) {
        ctx.provide('answer', 1);
        events.push('old:apply');
        ctx.effect(() => () => events.push('old:dispose'));
      },
    };
    const replacement: Plugin = {
      name: 'replacement-provider',
      async apply(ctx) {
        events.push('replacement:apply');
        if (failReplacement) throw new Error('replacement failed');
        ctx.effect(() => () => events.push('replacement:dispose'));
      },
    };
    let children = [usePlugin(oldProvider, undefined, { key: 'provider' })];
    const group = definePluginGroup({ name: 'replacement-lkg-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);
    expect(events).toEqual(['old:apply']);
    expect(ctx.get('answer')).toBe(1);

    children = [usePlugin(replacement, undefined, { key: 'provider' })];
    let failure: unknown;
    try {
      await fiber.update({});
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-child-failed',
      'replacement-provider',
      'owning Group',
      'repair the child',
    );
    expect(events).toEqual(['old:apply', 'replacement:apply']);
    expect(ctx.get('answer')).toBe(1);

    failReplacement = false;
    await fiber.update({});
    expect(events).toEqual(['old:apply', 'replacement:apply', 'replacement:apply', 'old:dispose']);
    expect(ctx.get('answer')).toBeUndefined();
    await ctx.fiber.dispose();
    expect(events).toEqual([
      'old:apply',
      'replacement:apply',
      'replacement:apply',
      'old:dispose',
      'replacement:dispose',
    ]);
  });

  it('does not infer a provider from a matching child name', async () => {
    let applied = 0;
    const namedChild: Plugin = {
      name: 'named-service',
      apply: () => {
        applied += 1;
      },
    };
    const dependent: Plugin = {
      name: 'dependent-on-name',
      inject: ['named-service'],
      apply: () => {
        applied += 1;
      },
    };
    const group = definePluginGroup({
      name: 'no-name-provider-inference-group',
      children: () => [usePlugin(dependent), usePlugin(namedChild)],
    });

    let failure: unknown;
    try {
      await new Context().plugin(group);
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-provider-missing',
      'named-service',
      'inject/provide dependency',
      'provide the service',
    );
    expect(applied).toBe(0);
  });

  it('hands off a healthy replacement that provides the same service token', async () => {
    const observed: number[] = [];
    const events: string[] = [];
    const provider = (name: string, value: number): Plugin => ({
      name,
      provide: 'answer',
      apply(ctx) {
        ctx.provide('answer', value);
        events.push(`${name}:apply`);
        ctx.effect(() => () => events.push(`${name}:dispose`));
      },
    });
    const consumer: Plugin = {
      name: 'replacement-consumer',
      inject: ['answer'],
      apply(ctx) {
        observed.push(Number(ctx.get('answer')));
      },
    };
    let children = [
      usePlugin(consumer),
      usePlugin(provider('old-answer', 1), undefined, { key: 'provider' }),
    ];
    const group = definePluginGroup({ name: 'same-service-swap-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);
    expect(observed.at(-1)).toBe(1);

    children = [
      usePlugin(consumer),
      usePlugin(provider('new-answer', 2), undefined, { key: 'provider' }),
    ];
    await fiber.update({});
    expect(observed.at(-1)).toBe(2);
    expect(ctx.get('answer')).toBe(2);
    expect(events).toContain('old-answer:dispose');
    expect(events).toContain('new-answer:apply');
    await ctx.fiber.dispose();
  });

  it('hands off a provider when only its stable key changes', async () => {
    const observed: number[] = [];
    const events: string[] = [];
    const provider: Plugin.Object<{ readonly value: number }> = {
      name: 'keyed-answer',
      provide: 'answer',
      apply(ctx, config) {
        ctx.provide('answer', config.value);
        events.push(`apply:${config.value}`);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    const consumer: Plugin = {
      name: 'key-change-consumer',
      inject: ['answer'],
      apply(ctx) {
        observed.push(Number(ctx.get('answer')));
      },
    };
    let children = [
      usePlugin(consumer),
      usePlugin(provider, { value: 1 }, { key: 'old-provider' }),
    ];
    const group = definePluginGroup({ name: 'key-change-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);

    children = [usePlugin(consumer), usePlugin(provider, { value: 2 }, { key: 'new-provider' })];
    await fiber.update({});
    expect(observed.at(-1)).toBe(2);
    expect(events).toEqual(['apply:1', 'dispose:1', 'apply:2']);
    await ctx.fiber.dispose();
  });

  it('restores a removed-key provider after a failed same-service handoff', async () => {
    const events: string[] = [];
    let fail = false;
    const provider: Plugin.Object<{ readonly value: number }> = {
      name: 'keyed-flaky-answer',
      provide: 'answer',
      async apply(ctx, config) {
        events.push(`apply:${config.value}`);
        if (fail && config.value === 2) throw new Error('temporary provider failure');
        ctx.provide('answer', config.value);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    let children = [usePlugin(provider, { value: 1 }, { key: 'old-provider' })];
    const group = definePluginGroup({ name: 'key-change-lkg-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);

    children = [usePlugin(provider, { value: 2 }, { key: 'new-provider' })];
    let failure: unknown;
    fail = true;
    try {
      await fiber.update({});
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-child-failed',
      'keyed-flaky-answer',
      'owning Group',
      'repair the child',
    );
    expect(ctx.get('answer')).toBe(1);
    expect(events).toEqual(['apply:1', 'dispose:1', 'apply:2', 'apply:1']);

    fail = false;
    await fiber.update({});
    expect(ctx.get('answer')).toBe(2);
    await ctx.fiber.dispose();
  });

  it('restores a same-service provider before rejecting and can retry the replacement', async () => {
    const events: string[] = [];
    let failReplacement = true;
    const oldProvider: Plugin = {
      name: 'stable-answer',
      provide: 'answer',
      apply(ctx) {
        ctx.provide('answer', 1);
        events.push('stable:apply');
        ctx.effect(() => () => events.push('stable:dispose'));
      },
    };
    const replacement: Plugin = {
      name: 'flaky-answer',
      provide: 'answer',
      async apply(ctx) {
        events.push('flaky:apply');
        if (failReplacement) throw new Error('replacement failed');
        ctx.provide('answer', 2);
        ctx.effect(() => () => events.push('flaky:dispose'));
      },
    };
    let children = [usePlugin(oldProvider, undefined, { key: 'provider' })];
    const group = definePluginGroup({ name: 'same-service-lkg-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);
    expect(ctx.get('answer')).toBe(1);

    children = [usePlugin(replacement, undefined, { key: 'provider' })];
    let failure: unknown;
    try {
      await fiber.update({});
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-child-failed',
      'flaky-answer',
      'owning Group',
      'repair the child',
    );
    expect(ctx.get('answer')).toBe(1);
    expect(events.at(-1)).toBe('stable:apply');

    failReplacement = false;
    await fiber.update({});
    expect(ctx.get('answer')).toBe(2);
    expect(events).toContain('stable:dispose');
    await ctx.fiber.dispose();
  });

  it('does not let a removed Group provider satisfy its remaining consumer', async () => {
    const events: string[] = [];
    const provider: Plugin = {
      name: 'group-answer',
      provide: 'answer',
      apply(ctx) {
        ctx.provide('answer', 1);
        events.push('provider:apply');
        ctx.effect(() => () => events.push('provider:dispose'));
      },
    };
    const consumer: Plugin = {
      name: 'remaining-consumer',
      inject: ['answer'],
      apply: () => {
        events.push('consumer:apply');
      },
    };
    let children = [usePlugin(provider), usePlugin(consumer)];
    const group = definePluginGroup({ name: 'removed-provider-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);
    expect(events).toEqual(['provider:apply', 'consumer:apply']);

    children = [usePlugin(consumer)];
    let failure: unknown;
    try {
      await fiber.update({});
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-provider-missing',
      'answer',
      'inject/provide dependency',
      'provide the service',
    );
    expect(events).toEqual(['provider:apply', 'consumer:apply']);
    expect(ctx.get('answer')).toBe(1);
    await ctx.fiber.dispose();
  });

  it('settles the old service before rejecting a failed config update', async () => {
    const events: string[] = [];
    const configurable: Plugin.Object<{ readonly value: number }> = {
      name: 'configurable-answer',
      provide: 'answer',
      async apply(ctx, config) {
        events.push(`apply:${config.value}`);
        if (config.value === 2) throw new Error('invalid answer update');
        ctx.provide('answer', config.value);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    let children = [usePlugin(configurable, { value: 1 })];
    const group = definePluginGroup({ name: 'config-lkg-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);
    expect(ctx.get('answer')).toBe(1);

    children = [usePlugin(configurable, { value: 2 })];
    let failure: unknown;
    try {
      await fiber.update({});
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-child-failed',
      'configurable-answer',
      'owning Group',
      'repair the child',
    );
    await fiber.await();
    expect(ctx.get('answer')).toBe(1);
    expect(events).toEqual(['apply:1', 'dispose:1', 'apply:2', 'apply:1']);
    await ctx.fiber.dispose();
  });

  it('settles children through native Fiber dependencies rather than array order', async () => {
    const events: string[] = [];
    const provider: Plugin = {
      name: 'provider',
      provide: 'world',
      apply(ctx) {
        events.push('provider:apply');
        ctx.provide('world', {});
        ctx.effect(() => () => events.push('provider:dispose'));
      },
    };
    const consumer: Plugin = {
      name: 'consumer',
      inject: ['world'],
      apply(ctx) {
        events.push('consumer:apply');
        ctx.effect(() => () => events.push('consumer:dispose'));
      },
    };
    const group = definePluginGroup({
      name: 'ordered-by-services',
      children: () => [usePlugin(consumer), usePlugin(provider)],
    });
    const ctx = new Context();

    await ctx.plugin(group);
    expect(events).toEqual(['provider:apply', 'consumer:apply']);
    await ctx.fiber.dispose();
    expect(events).toEqual([
      'provider:apply',
      'consumer:apply',
      'consumer:dispose',
      'provider:dispose',
    ]);
  });

  it('starts independent children before any one child settles', async () => {
    const events: string[] = [];
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondSettled = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    let started = 0;
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const first = {
      name: 'first-independent',
      async apply() {
        events.push('first-independent:start');
        started += 1;
        if (started === 2) resolveBothStarted();
        await firstSettled;
        events.push('first-independent:settled');
      },
    } satisfies Plugin;
    const second = {
      name: 'second-independent',
      async apply() {
        events.push('second-independent:start');
        started += 1;
        if (started === 2) resolveBothStarted();
        await secondSettled;
        events.push('second-independent:settled');
      },
    } satisfies Plugin;
    const group = definePluginGroup({
      name: 'parallel-start-group',
      children: () => [usePlugin(first), usePlugin(second)],
    });
    const ctx = new Context();
    const groupFiber = ctx.plugin(group);

    await bothStarted;
    expect(events).toEqual(['first-independent:start', 'second-independent:start']);
    expect(events).not.toContain('first-independent:settled');
    resolveFirst();
    await firstSettled;
    resolveSecond();
    await groupFiber;
    expect(events).toEqual([
      'first-independent:start',
      'second-independent:start',
      'first-independent:settled',
      'second-independent:settled',
    ]);
    await ctx.fiber.dispose();
  });

  it('reports the child whose Fiber actually failed', async () => {
    const failing: Plugin = {
      name: 'first-failing-child',
      apply() {
        throw new Error('first child failed');
      },
    };
    const sibling: Plugin = {
      name: 'last-sibling-child',
      apply(ctx) {
        ctx.effect(() => () => undefined);
      },
    };
    const group = definePluginGroup({
      name: 'failure-owner-group',
      children: () => [usePlugin(failing), usePlugin(sibling)],
    });

    let failure: unknown;
    try {
      await new Context().plugin(group);
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-child-failed',
      'first-failing-child',
      'owning Group',
      'repair the child',
    );
  });

  it('cleans failed candidates in reverse and propagates rollback failures', async () => {
    const events: string[] = [];
    let restoreShouldFail = false;
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    let resolveSecondDisposeStarted!: () => void;
    const secondDisposeStarted = new Promise<void>((resolve) => {
      resolveSecondDisposeStarted = resolve;
    });
    let resolveFirstDisposeStarted!: () => void;
    const firstDisposeStarted = new Promise<void>((resolve) => {
      resolveFirstDisposeStarted = resolve;
    });
    const oldProvider: Plugin = {
      name: 'old-rollback-provider',
      provide: 'answer',
      apply(ctx) {
        if (restoreShouldFail) throw new Error('old provider restore failed');
        ctx.provide('answer', 1);
      },
    };
    const first: Plugin = {
      name: 'first-candidate',
      apply(ctx) {
        ctx.effect(() => async () => {
          events.push('first:dispose:start');
          resolveFirstDisposeStarted();
          await firstGate;
          events.push('first:dispose:end');
        });
      },
    };
    const second: Plugin = {
      name: 'second-candidate',
      apply(ctx) {
        ctx.effect(() => async () => {
          events.push('second:dispose:start');
          resolveSecondDisposeStarted();
          await secondGate;
          events.push('second:dispose:end');
        });
      },
    };
    const failing: Plugin = {
      name: 'rollback-trigger',
      provide: 'answer',
      apply() {
        throw new Error('candidate activation failed');
      },
    };
    let children = [usePlugin(oldProvider, undefined, { key: 'old-provider' })];
    const group = definePluginGroup({
      name: 'reverse-cleanup-group',
      children: () => children,
    });
    const ctx = new Context();
    const groupFiber = await ctx.plugin(group);
    restoreShouldFail = true;
    children = [usePlugin(first), usePlugin(second), usePlugin(failing)];

    const update = Promise.resolve(groupFiber.update({}));
    await secondDisposeStarted;
    expect(events).toEqual(['second:dispose:start']);
    resolveSecond();
    await firstDisposeStarted;
    expect(events).toEqual(['second:dispose:start', 'second:dispose:end', 'first:dispose:start']);
    resolveFirst();
    await update.catch((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) return;
      expect(error.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'old provider restore failed' }),
        ]),
      );
      expect(
        error.errors.some(
          (item: unknown) =>
            item instanceof PluginCompositionError &&
            item.code === 'plugin-group-child-failed' &&
            item.detail.child === 'rollback-trigger',
        ),
      ).toBe(true);
    });
    expect(events).toEqual([
      'second:dispose:start',
      'second:dispose:end',
      'first:dispose:start',
      'first:dispose:end',
    ]);
  });

  it('rejects repeated plugin references without a stable key before side effects', async () => {
    let applied = 0;
    const child: Plugin = {
      name: 'repeated-child',
      apply: () => {
        applied += 1;
      },
    };
    const group = definePluginGroup({
      name: 'missing-key-group',
      children: () => [usePlugin(child), usePlugin(child)],
    });

    let failure: unknown;
    try {
      await new Context().plugin(group);
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-key-required',
      'repeated-child',
      'stable child key',
      'assign a unique key',
    );
    expect(applied).toBe(0);
  });

  it('rolls back already-active children when a later child fails', async () => {
    const events: string[] = [];
    const healthy: Plugin = {
      name: 'healthy',
      apply(ctx) {
        events.push('healthy:apply');
        ctx.effect(() => () => events.push('healthy:dispose'));
      },
    };
    const failing: Plugin = {
      name: 'failing',
      apply() {
        events.push('failing:apply');
        throw new Error('child activation failed');
      },
    };
    const group = definePluginGroup({
      name: 'rollback-group',
      children: () => [usePlugin(healthy), usePlugin(failing)],
    });

    let failure: unknown;
    try {
      await new Context().plugin(group);
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-child-failed',
      'failing',
      'owning Group',
      'repair the child',
    );
    expect(events).toEqual(['healthy:apply', 'failing:apply', 'healthy:dispose']);
  });

  it('rejects invalid Plugin.Config before the child side effect', async () => {
    let applied = 0;
    const configured: Plugin.Function<{ readonly speed: number }> = Object.assign(
      function configured(_ctx: Context, _config: { readonly speed: number }) {
        applied += 1;
      },
      {
        Config: {
          '~standard': {
            version: 1 as const,
            vendor: 'forgeax-t1-1',
            validate(value: unknown) {
              if (typeof value !== 'object' || value === null) {
                return { issues: [{ message: 'config must be an object' }] };
              }
              const candidate = value as Record<string, unknown>;
              if (Object.keys(candidate).length !== 1 || typeof candidate.speed !== 'number') {
                return { issues: [{ message: 'config requires only numeric speed' }] };
              }
              return { value: { speed: candidate.speed } };
            },
          },
        },
      },
    );
    const group = definePluginGroup({
      name: 'invalid-config-group',
      children: () => [
        usePlugin(configured, { speed: 'bad' } as unknown as { readonly speed: number }),
      ],
    });

    let failure: unknown;
    try {
      await new Context().plugin(group);
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-config-invalid',
      'configured',
      'Plugin.Config',
      'provide a valid config',
    );
    expect(applied).toBe(0);
  });

  it('validates every candidate before releasing the current service owner', async () => {
    const events: string[] = [];
    const provider: Plugin.Object<{ readonly value: number }> = {
      name: 'preflight-provider',
      provide: 'answer',
      apply(ctx, config) {
        ctx.provide('answer', config.value);
        events.push(`apply:${config.value}`);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    const invalid: Plugin.Function<{ readonly value: number }> = Object.assign(
      function invalidCandidate() {
        events.push('invalid:apply');
      },
      {
        Config: {
          '~standard': {
            version: 1 as const,
            vendor: 'forgeax-t1-2',
            validate(value: unknown) {
              if (typeof value !== 'object' || value === null) {
                return { issues: [{ message: 'candidate config must be an object' }] };
              }
              return { issues: [{ message: 'candidate config is rejected' }] };
            },
          },
        },
      },
    );
    let children = [usePlugin(provider, { value: 1 }, { key: 'old-provider' })];
    const group = definePluginGroup({ name: 'preflight-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);

    children = [
      usePlugin(provider, { value: 2 }, { key: 'new-provider' }),
      usePlugin(invalid, { value: 3 }, { key: 'invalid' }),
    ];
    let failure: unknown;
    try {
      await fiber.update({});
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-config-invalid',
      'invalidCandidate',
      'Plugin.Config',
      'provide a valid config',
    );
    expect(events).toEqual(['apply:1']);
    expect(ctx.get('answer')).toBe(1);
    await ctx.fiber.dispose();
  });

  it('updates a function-valued config on the same child Fiber', async () => {
    const calls: number[] = [];
    const childFibers: unknown[] = [];
    const configurable: Plugin.Object<{ readonly callback: () => number }> = {
      name: 'function-config-child',
      apply(ctx, config) {
        childFibers.push(ctx.fiber);
        calls.push(config.callback());
      },
    };
    let children = [usePlugin(configurable, { callback: () => 1 })];
    const group = definePluginGroup({ name: 'function-config-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);

    children = [usePlugin(configurable, { callback: () => 2 })];
    await fiber.update({});
    expect(calls).toEqual([1, 2]);
    expect(childFibers[0]).toBe(childFibers[1]);
    await ctx.fiber.dispose();
  });

  it('does not retain candidates when an invalid runtime child stops creation', async () => {
    const events: string[] = [];
    const baseline: Plugin = {
      name: 'baseline-child',
      apply(ctx) {
        ctx.effect(() => () => events.push('baseline:dispose'));
      },
    };
    const first: Plugin = {
      name: 'first-candidate',
      apply(ctx) {
        events.push('first:apply');
        ctx.effect(() => () => events.push('first:dispose'));
      },
    };
    const invalid = { name: 'invalid-runtime-child' } as unknown as Plugin;
    const last: Plugin = {
      name: 'last-candidate',
      apply(ctx) {
        events.push('last:apply');
        ctx.effect(() => () => events.push('last:dispose'));
      },
    };
    let children = [usePlugin(baseline)];
    const group = definePluginGroup({
      name: 'candidate-registration-group',
      children: () => children,
    });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);

    children = [usePlugin(first), usePlugin(invalid), usePlugin(last)];
    let failure: unknown;
    try {
      await fiber.update({});
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-child-failed',
      'invalid-runtime-child',
      'owning Group',
      'repair the child',
    );
    expect(events).toEqual([]);
    await ctx.fiber.dispose();
    expect(events).toEqual(['baseline:dispose']);
  });

  it('rejects duplicate stable keys before creating child side effects', async () => {
    let applied = 0;
    const child: Plugin = {
      name: 'child',
      apply: () => {
        applied += 1;
      },
    };
    const group = definePluginGroup({
      name: 'duplicate-key-group',
      children: () => [
        usePlugin(child, undefined, { key: 'same' }),
        usePlugin(child, undefined, { key: 'same' }),
      ],
    });

    let failure: unknown;
    try {
      await new Context().plugin(group);
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-key-duplicate',
      'same',
      'stable child key',
      'assign a unique key',
    );
    expect(applied).toBe(0);
  });

  it('rejects a missing provider before activating the dependent child', async () => {
    let applied = 0;
    const dependent: Plugin = {
      name: 'dependent',
      inject: ['missing-service'],
      apply: () => {
        applied += 1;
      },
    };
    const group = definePluginGroup({
      name: 'missing-provider-group',
      children: () => [usePlugin(dependent)],
    });

    let failure: unknown;
    try {
      await new Context().plugin(group);
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-provider-missing',
      'missing-service',
      'inject/provide dependency',
      'provide the service',
    );
    expect(applied).toBe(0);
  });

  it('rejects a dependency cycle before activating either child', async () => {
    let applied = 0;
    const first: Plugin = {
      name: 'first',
      inject: ['second'],
      provide: 'first',
      apply: () => {
        applied += 1;
      },
    };
    const second: Plugin = {
      name: 'second',
      inject: ['first'],
      provide: 'second',
      apply: () => {
        applied += 1;
      },
    };
    const group = definePluginGroup({
      name: 'cycle-group',
      children: () => [usePlugin(first), usePlugin(second)],
    });

    let failure: unknown;
    try {
      await new Context().plugin(group);
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-dependency-cycle',
      'first',
      'inject/provide dependency graph',
      'break the dependency cycle',
    );
    expect(applied).toBe(0);
  });

  it('preserves child identity across reorder and diffs add/remove children', async () => {
    const events: string[] = [];
    const first: Plugin = {
      name: 'first',
      apply(ctx) {
        events.push('first:apply');
        ctx.effect(() => () => events.push('first:dispose'));
      },
    };
    const second: Plugin = {
      name: 'second',
      apply(ctx) {
        events.push('second:apply');
        ctx.effect(() => () => events.push('second:dispose'));
      },
    };
    const third: Plugin = {
      name: 'third',
      apply(ctx) {
        events.push('third:apply');
        ctx.effect(() => () => events.push('third:dispose'));
      },
    };
    let children = [usePlugin(first), usePlugin(second)];
    const group = definePluginGroup({ name: 'diff-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);
    expect(events).toEqual(['first:apply', 'second:apply']);

    children = [usePlugin(second), usePlugin(first)];
    await fiber.update({});
    expect(events).toEqual(['first:apply', 'second:apply']);

    children = [usePlugin(second), usePlugin(third)];
    await fiber.update({});
    expect(events).toEqual(['first:apply', 'second:apply', 'third:apply', 'first:dispose']);
    await ctx.fiber.dispose();
    expect(events).toEqual([
      'first:apply',
      'second:apply',
      'third:apply',
      'first:dispose',
      'third:dispose',
      'second:dispose',
    ]);
  });

  it('preserves keyed identity across reorder of equivalent fresh data configs', async () => {
    const events: string[] = [];
    const childFibers = new Map<number, unknown[]>();
    const configurable: Plugin.Object<{ readonly value: number }> = {
      name: 'reorder-configurable',
      apply(ctx, config) {
        const fibers = childFibers.get(config.value) ?? [];
        fibers.push(ctx.fiber);
        childFibers.set(config.value, fibers);
        events.push(`apply:${config.value}`);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    let children = [
      usePlugin(configurable, { value: 1 }, { key: 'first' }),
      usePlugin(configurable, { value: 2 }, { key: 'second' }),
    ];
    const group = definePluginGroup({ name: 'reorder-config-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);

    children = [
      usePlugin(configurable, { value: 2 }, { key: 'second' }),
      usePlugin(configurable, { value: 1 }, { key: 'first' }),
    ];
    await fiber.update({});
    expect(events).toEqual(['apply:1', 'apply:2']);
    expect(childFibers.get(1)).toHaveLength(1);
    expect(childFibers.get(2)).toHaveLength(1);
    await ctx.fiber.dispose();
    expect(events).toEqual(['apply:1', 'apply:2', 'dispose:2', 'dispose:1']);
  });

  it('keeps the last-known-good child set after async failure and retries it', async () => {
    const events: string[] = [];
    let fail = true;
    const healthy: Plugin = {
      name: 'healthy-lkg',
      apply(ctx) {
        events.push('healthy:apply');
        ctx.effect(() => () => events.push('healthy:dispose'));
      },
    };
    const flaky: Plugin = {
      name: 'flaky',
      async apply(ctx) {
        events.push('flaky:apply');
        if (fail) throw new Error('temporary child failure');
        ctx.effect(() => () => events.push('flaky:dispose'));
      },
    };
    let children = [usePlugin(healthy)];
    const group = definePluginGroup({ name: 'lkg-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);
    expect(events).toEqual(['healthy:apply']);

    children = [usePlugin(healthy), usePlugin(flaky)];
    let failure: unknown;
    try {
      await fiber.update({});
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-child-failed',
      'flaky',
      'owning Group',
      'repair the child',
    );
    expect(events).toEqual(['healthy:apply', 'flaky:apply']);

    fail = false;
    await fiber.update({});
    expect(events).toEqual(['healthy:apply', 'flaky:apply', 'flaky:apply']);
    await ctx.fiber.dispose();
    expect(events).toEqual([
      'healthy:apply',
      'flaky:apply',
      'flaky:apply',
      'flaky:dispose',
      'healthy:dispose',
    ]);
  });

  it('reports retirement disposal failure through the Group error contract and preserves LKG', async () => {
    let failDispose = true;
    const events: string[] = [];
    const retiringProvider: Plugin = {
      name: 'retiring-provider',
      provide: 'answer',
      apply(ctx) {
        ctx.provide('answer', 1);
        const fiber = ctx.fiber as unknown as { dispose: () => Promise<void> };
        const originalDispose = fiber.dispose.bind(ctx.fiber);
        fiber.dispose = async () => {
          events.push('retiring:dispose');
          await originalDispose();
          if (failDispose) throw new Error('retirement failed');
        };
      },
    };
    const consumer: Plugin = {
      name: 'retirement-consumer',
      inject: ['answer'],
      apply(ctx) {
        events.push(`consumer:${ctx.get('answer')}`);
      },
    };
    let children = [usePlugin(retiringProvider), usePlugin(consumer)];
    const group = definePluginGroup({
      name: 'retirement-failure-group',
      children: () => children,
    });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);

    children = [];
    let failure: unknown;
    try {
      await fiber.update({});
    } catch (error: unknown) {
      failure = error;
    }
    assertCompositionFailure(
      failure,
      'plugin-group-child-failed',
      'retiring-provider',
      'owning Group',
      'repair the child',
    );
    expect(ctx.get('answer')).toBe(1);
    expect(events).toEqual(['consumer:1', 'retiring:dispose', 'consumer:1']);

    failDispose = false;
    await fiber.update({});
    expect(ctx.get('answer')).toBeUndefined();
    await ctx.fiber.dispose();
  });

  it('updates an existing child config without changing its identity', async () => {
    const events: string[] = [];
    const childFibers: unknown[] = [];
    const configurable: Plugin.Object<{ readonly value: number }> = {
      name: 'configurable',
      apply(ctx, config) {
        childFibers.push(ctx.fiber);
        events.push(`apply:${config.value}`);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    let children = [usePlugin(configurable, { value: 1 })];
    const group = definePluginGroup({ name: 'config-update-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);
    expect(events).toEqual(['apply:1']);

    children = [usePlugin(configurable, { value: 2 })];
    await fiber.update({});
    expect(events).toEqual(['apply:1', 'dispose:1', 'apply:2']);
    expect(childFibers).toHaveLength(2);
    expect(childFibers[0]).toBe(childFibers[1]);
    await ctx.fiber.dispose();
    expect(events).toEqual(['apply:1', 'dispose:1', 'apply:2', 'dispose:2']);
  });

  it('activates keyed instances independently and disposes only the removed key', async () => {
    const events: string[] = [];
    const childFibers: unknown[] = [];
    const reusable: Plugin.Object<{ readonly value: number }> = {
      name: 'reusable',
      apply(ctx, config) {
        childFibers.push(ctx.fiber);
        events.push(`apply:${config.value}`);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    const leftConfig = { value: 1 };
    const rightConfig = { value: 2 };
    let children = [
      usePlugin(reusable, leftConfig, { key: 'left' }),
      usePlugin(reusable, rightConfig, { key: 'right' }),
    ];
    const group = definePluginGroup({ name: 'keyed-group', children: () => children });
    const ctx = new Context();
    const fiber = await ctx.plugin(group);
    expect(events).toEqual(['apply:1', 'apply:2']);
    expect(childFibers).toHaveLength(2);
    expect(childFibers[0]).not.toBe(childFibers[1]);

    children = [usePlugin(reusable, rightConfig, { key: 'right' })];
    await fiber.update({});
    expect(events).toEqual(['apply:1', 'apply:2', 'dispose:1']);
    expect(childFibers).toHaveLength(2);

    await ctx.fiber.dispose();
    expect(events).toEqual(['apply:1', 'apply:2', 'dispose:1', 'dispose:2']);
  });
});

describe('project plugin owner validation', () => {
  it('returns a structured failure for mixed realm ownership', () => {
    const entries = [
      {
        id: 'mixed',
        name: 'cordis:group',
        group: true,
        realm: 'engine' as const,
        config: [{ id: 'host', name: '@game/host', realm: 'host' as const }],
      },
    ];

    expect(() => projectPluginEntries(entries, 'engine')).toThrow(CatalogLoaderError);
    try {
      projectPluginEntries(entries, 'engine');
    } catch (error: unknown) {
      assertCatalogFailure(
        error,
        'plugin-entry-realm-mixed',
        'mixed',
        'engine physical realm',
        'Split Host and Engine',
      );
    }
  });

  it('keeps missing module, realm mismatch, and unsupported realm failures closed', async () => {
    const ctx = new Context();
    const { loader } = await installCatalogLoader(
      ctx,
      new Map([
        [
          '@game/host',
          { realm: 'host' as const, load: async () => ({ default: () => undefined }) },
        ],
      ]),
      'engine',
    );

    for (const candidate of [
      { name: '@game/missing', code: 'plugin-catalog-missing' as const },
      { name: '@game/host', code: 'plugin-realm-mismatch' as const },
    ]) {
      let failure: unknown;
      try {
        await loader.create({ name: candidate.name });
      } catch (error: unknown) {
        failure = error instanceof Error && 'cause' in error ? error.cause : error;
      }
      assertCatalogFailure(
        failure,
        candidate.code,
        candidate.name,
        candidate.code === 'plugin-catalog-missing' ? 'generated catalog' : 'engine realm',
        candidate.code === 'plugin-catalog-missing' ? 'Install the package' : 'realm-specific',
      );
    }

    const unsupported = await bootstrapCatalogLoader(ctx, new Map(), 'host', {
      catalogDigest: 'digest',
      supportedRealms: ['engine'],
    });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      assertCatalogFailure(
        unsupported.error,
        'plugin-realm-unsupported',
        'host',
        'supported by this host',
        'capability matrix',
      );
    }
    await ctx.fiber.dispose();
  });
});
