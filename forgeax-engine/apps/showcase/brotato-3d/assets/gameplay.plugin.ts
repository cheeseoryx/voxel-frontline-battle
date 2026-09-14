import { definePluginGroup, usePlugin } from '@forgeax/engine-plugin';
import { gameplay } from './plugins/game-plugin.ts';

export default definePluginGroup({
  name: 'brotato-3d',
  children: () => [usePlugin(gameplay, undefined, { key: 'gameplay' })],
});
