import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
import cameraPlugin from './camera/camera.plugin.ts';
import playerPlugin from './player/player.plugin.ts';
import uiPlugin from './ui/ui.plugin.ts';
import worldPlugin from './world/world.plugin.ts';

const game3dRoot = definePluginGroup({
  name: 'game-3d',
  children: () => [
    usePlugin(worldPlugin, undefined, { key: 'world' }),
    usePlugin(playerPlugin, undefined, { key: 'player' }),
    usePlugin(cameraPlugin, undefined, { key: 'camera' }),
    usePlugin(uiPlugin, undefined, { key: 'ui' }),
  ],
});

export default game3dRoot;
