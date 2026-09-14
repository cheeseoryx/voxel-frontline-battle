import {definePluginGroup,usePlugin} from '@forgeax/engine/plugin';
import uiPlugin from './ui/ui.plugin.ts';
export default definePluginGroup({name:'voxel-frontline',children:()=>[usePlugin(uiPlugin,undefined,{key:'ui'})]});
