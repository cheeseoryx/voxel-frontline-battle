import type {} from '@forgeax/engine/app';
import type {Plugin} from '@forgeax/engine/plugin';
import {AssetGuid} from '@forgeax/engine/pack/guid';
import {mountUi,type UiAsset} from '@forgeax/engine/ui';
import {IDS} from '../identity.ts';

type FrontlineMenuState={screen:'home'|'modes'|'servers';selectedMode:string|null};
const MENU_STATE='voxel-frontline/menu';
const plugin:Plugin={name:'voxel-frontline/ui',inject:['world','gameHost'],async apply(ctx){
 const host=ctx.gameHost;if(!host)throw Error('App GameHost is required');
 const id=AssetGuid.parse(IDS.ui);if(!id.ok)throw id.error;
 const loaded=await host.assets.loadByGuid<UiAsset>(id.value);if(!loaded.ok)throw loaded.error;
 const mounted=mountUi(loaded.value,{root:host.uiRoot??document.body,layer:50});if(!mounted.ok)throw mounted.error;const ui=mounted.value;
 const root=ui.host.shadowRoot!;if(!root)throw Error('Native UI did not mount');
 const state:FrontlineMenuState={screen:'home',selectedMode:null};ctx.world.insertResource(MENU_STATE,state);
 const find=(id:string)=>root.getElementById(id) as HTMLElement|null;
 const show=(id:string,visible:boolean)=>find(id)?.classList.toggle('hidden',!visible);
 function display(screen:FrontlineMenuState['screen']){
  state.screen=screen;show('start-overlay',screen==='home');show('mode-overlay',screen!=='home');show('server-browser',screen==='servers');show('mode-scroll',screen==='modes');
  const sub=root.querySelector<HTMLElement>('.frontline-subnav');if(sub)sub.classList.toggle('hidden',screen==='servers');
  document.documentElement.dataset.frontlineScreen=screen;
 }
 const enter=find('enter-hub-btn') as HTMLButtonElement|null;if(enter){enter.disabled=false;const label=enter.querySelector('span:last-child');if(label)label.textContent='进入大厅';}
 display('home');
 const click=(event:Event)=>{
  const element=event.target as Element;const button=element.closest<HTMLElement>('button,[data-mode-action]');if(!button)return;
  if(button.id==='enter-hub-btn'){event.preventDefault();display('modes');return;}
  const action=button.dataset.modeAction;
  if(action==='close'){event.preventDefault();display('home');}
  if(action==='mode-home'||action==='server-back'){event.preventDefault();display('modes');}
  if(action==='servers'){event.preventDefault();display('servers');}
 };
 root.addEventListener('click',click);
 // Mark the current implementation scope in the development host. Gameplay
 // actions are wired by their owning mode plugins during migration.
 ui.host.dataset.migrationStage='ui-shell';
 ctx.effect(()=>()=>{root.removeEventListener('click',click);ctx.world.removeResource(MENU_STATE);ui.dispose();},'voxel-frontline/ui');
}};
export default plugin;

