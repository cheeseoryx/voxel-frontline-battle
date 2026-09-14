import {definePluginGroup,usePlugin} from '@forgeax/engine/plugin';
import {physicsPlugin} from '@forgeax/engine/physics';
import battlePlugin from './gameplay/battle.plugin.ts';
import uiPlugin from './ui/ui.plugin.ts';
export default definePluginGroup({name:'voxel-frontline',children:()=>[usePlugin(physicsPlugin('rapier-3d'),undefined,{key:'physics'}),usePlugin(battlePlugin,undefined,{key:'battle'}),usePlugin(uiPlugin,undefined,{key:'ui'})]});
