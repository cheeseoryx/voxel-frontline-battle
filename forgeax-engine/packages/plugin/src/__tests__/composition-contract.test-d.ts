import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';
import { expectTypeOf, it } from 'vitest';
import type { CatalogLoaderError } from '../index.js';
import { definePluginGroup, usePlugin } from '../index.js';

interface MovementConfig {
  readonly speed: number;
}

const movement: Plugin.Function<MovementConfig> = (_ctx: Context, _config: MovementConfig) => {};
const camera: Plugin = { name: 'camera', apply: () => undefined };

const movementChild = usePlugin(movement, { speed: 6 });
const game = definePluginGroup({
  name: 'game',
  children: () => [movementChild, usePlugin(camera)],
});

expectTypeOf(game).toMatchTypeOf<Plugin>();
expectTypeOf(game).not.toMatchTypeOf<Fiber>();

// @ts-expect-error usePlugin must reject config values outside Plugin.Config.
usePlugin(movement, { speed: 'fast' });

// @ts-expect-error a required Plugin.Config cannot be omitted.
usePlugin(movement);

// @ts-expect-error excess config fields are rejected before activation.
usePlugin(movement, { speed: 6, unexpected: true });

usePlugin(movement, { speed: 1 }, { key: 'wave-one' });
usePlugin(movement, { speed: 2 }, { key: 'wave-two' });

function describeCatalogLoaderError(error: CatalogLoaderError): string {
  switch (error.code) {
    case 'plugin-catalog-missing':
      expectTypeOf(error.detail.name).toBeString();
      // @ts-expect-error a missing-catalog detail cannot expose realm-mismatch fields.
      error.detail.actual;
      return `${error.expected}:${error.hint}:${error.detail.name}`;
    case 'plugin-realm-mismatch':
      expectTypeOf(error.detail.name).toBeString();
      expectTypeOf(error.detail.actual).toBeString();
      expectTypeOf(error.detail.expected).toBeString();
      // @ts-expect-error a realm mismatch detail cannot expose group ownership fields.
      error.detail.group;
      return `${error.expected}:${error.hint}:${error.detail.name}:${error.detail.actual}`;
    case 'plugin-entry-realm-mixed':
      expectTypeOf(error.detail.group).toBeString();
      expectTypeOf(error.detail.actual).toBeString();
      expectTypeOf(error.detail.expected).toBeString();
      // @ts-expect-error a mixed-realm detail cannot expose a catalog module name.
      error.detail.name;
      return `${error.expected}:${error.hint}:${error.detail.group}`;
    case 'plugin-realm-unsupported':
      expectTypeOf(error.detail.realm).toBeString();
      expectTypeOf(error.detail.supportedRealms).toMatchTypeOf<readonly string[]>();
      // @ts-expect-error an unsupported-realm detail cannot expose a module name.
      error.detail.name;
      return `${error.expected}:${error.hint}:${error.detail.realm}`;
    case 'plugin-catalog-digest-mismatch':
      expectTypeOf(error.detail.actual).toBeString();
      expectTypeOf(error.detail.expected).toBeString();
      // @ts-expect-error a digest detail cannot expose group ownership fields.
      error.detail.group;
      return `${error.expected}:${error.hint}:${error.detail.actual}`;
  }
}

it('exposes a native Plugin group and typed child declarations', () => {
  expectTypeOf(movementChild).toMatchTypeOf<unknown>();
  expectTypeOf(game).toMatchTypeOf<Plugin>();
  expectTypeOf(describeCatalogLoaderError).toBeFunction();
});
