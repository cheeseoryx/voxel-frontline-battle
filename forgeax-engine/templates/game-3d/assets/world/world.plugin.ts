import type { Plugin } from '@forgeax/engine/plugin';

const worldPlugin: Plugin = {
  name: 'game-3d/world',
  inject: ['world'],
  apply(ctx) {
    ctx.provide('game-3d/world-owner', true);
    ctx.effect(() => () => undefined, 'game-3d/world-owner');
  },
};

export default worldPlugin;
