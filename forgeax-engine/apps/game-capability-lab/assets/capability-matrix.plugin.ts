import { definePluginGroup, usePlugin } from '@forgeax/engine-plugin';
import { gameplay } from './plugins/game-plugin.ts';

export default definePluginGroup({
  name: 'game-capability-lab',
  children: () => [usePlugin(gameplay, undefined, { key: 'capability-matrix' })],
});
