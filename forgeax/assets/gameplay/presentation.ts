import type {GameHost} from '@forgeax/engine/app';
import type {World,EntityHandle} from '@forgeax/engine/ecs';
import {Transform,sceneEntity,worldResolveSceneEntity} from '@forgeax/engine/scene';
import {Camera,MeshFilter,MeshRenderer,Visibility,VisibilityStateValue,perspective} from '@forgeax/engine/render';
import type {MeshAsset,Handle} from '@forgeax/engine/types';
import {modelGuid,equipmentGuid} from '../identity.ts';
import {classesFor,runtimeFor,teamless,type ModeId} from './catalog.ts';
export async function createPresentation(world:World,host:GameHost){
 if(host.defaultSceneRoot===undefined)throw Error('Missing deployment scene instance');
 const resolve=(key:string)=>worldResolveSceneEntity(world,host.defaultSceneRoot!,sceneEntity('scene/deployment',key)).unwrap();
 const members=[0,1,2,3].map(i=>resolve('squad/'+i)),camera=resolve('camera');
 let selection=0,inspectEntity:EntityHandle|undefined;const guns=new Map<string,Handle<'MeshAsset','shared'>>();
 function hideGun(){selection++;if(inspectEntity!==undefined){world.despawn(inspectEntity).unwrap();inspectEntity=undefined;}}
 const models=new Map<string,Handle<'MeshAsset','shared'>>();
 for(const mode of ['conquest','tdm'] as const)for(const cls of classesFor(mode)){
  const key=(mode==='tdm'?'small/':'')+'ally/'+cls.id;
  const asset=await host.assets.loadByGuid<MeshAsset>(modelGuid('soldier/'+key));if(!asset.ok)throw asset.error;
  models.set(key,world.allocSharedRef('MeshAsset',asset.value));
 }
 for(const e of members)if(!world.hasComponent(e,Visibility))world.addComponent(e,{component:Visibility,data:{state:VisibilityStateValue.hidden}}).unwrap();
 const canvas=host.canvas,origin=canvas.parentNode!,next=canvas.nextSibling,originalStyle=canvas.getAttribute('style');
 function place(target:HTMLElement|null,mode:ModeId,classId:string,squad:boolean){
  hideGun();
  if(!target){for(const e of members)world.set(e,Visibility,{state:VisibilityStateValue.hidden}).unwrap();canvas.style.visibility='hidden';return;}
  target.appendChild(canvas);canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;display:block;visibility:visible;pointer-events:none;';
  target.style.position='relative';
  const cls=classesFor(mode);const count=squad?(teamless(mode)?1:4):1;
  const box=target.getBoundingClientRect(),aspect=Math.max(.1,box.width/Math.max(1,box.height));const halfWidth=Math.tan(37*Math.PI/360)*3.65*aspect;
  members.forEach((e,i)=>{world.set(e,Visibility,{state:i<count?VisibilityStateValue.visible:VisibilityStateValue.hidden}).unwrap();if(i>=count)return;
   const id=i===0?classId:cls[i%cls.length].id,key=(runtimeFor(mode)==='small'?'small/':'')+'ally/'+id;
   world.set(e,MeshFilter,{assetHandle:models.get(key)!}).unwrap();world.set(e,Transform,{pos:[count===1?0:halfWidth*(-.75+i*.5),0,0],quat:[0,1,0,0]}).unwrap();
  });
  world.set(camera,Transform,{pos:[0,1.05,squad?3.65:3.5],quat:[0,0,0,1]}).unwrap();
  world.set(camera,Camera,{...perspective({fov:37*Math.PI/180,aspect,near:.08,far:100,autoAspect:false}),clearColor:[0,0,0,0]}).unwrap();
 }
 function battle(){hideGun();for(const e of members)world.set(e,Visibility,{state:VisibilityStateValue.hidden}).unwrap();origin.appendChild(canvas);if(originalStyle===null)canvas.removeAttribute('style');else canvas.setAttribute('style',originalStyle);canvas.style.visibility='visible';}
 async function inspect(target:HTMLElement,id:string,mode:ModeId='conquest'){
  hideGun();const ticket=selection;for(const e of members)world.set(e,Visibility,{state:VisibilityStateValue.hidden}).unwrap();
  target.appendChild(canvas);target.style.position='relative';canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;display:block;visibility:visible;pointer-events:none;';
  const gunKey=(runtimeFor(mode)==='small'?'small/inspect/':'gun/')+id;let handle=guns.get(gunKey);if(!handle){const result=await host.assets.loadByGuid<MeshAsset>(equipmentGuid(gunKey));if(!result.ok)throw result.error;if(ticket!==selection)return;handle=world.allocSharedRef('MeshAsset',result.value);guns.set(gunKey,handle);}
  if(ticket!==selection)return;const mesh=world.sharedRefs.resolve<'MeshAsset',MeshAsset>(handle).unwrap();const bounds=mesh.aabb;if(!bounds||bounds.length!==6)throw Error('Weapon asset has no valid bounds');const min=bounds.subarray(0,3),max=bounds.subarray(3,6);
  const center=[0,1,2].map(a=>(min[a]+max[a])/2),size=Math.max(...[0,1,2].map(a=>max[a]-min[a]),.35),dist=size*2.35;
  inspectEntity=world.spawn({component:Transform,data:{pos:center.map(v=>-v)}},{component:MeshFilter,data:{assetHandle:handle}},{component:MeshRenderer,data:{materials:[]}}).unwrap();
  const pos=[dist*.72,size*.38,dist*.95],yaw=Math.atan2(pos[0],pos[2]),pitch=-Math.atan2(pos[1],Math.hypot(pos[0],pos[2]));const hp=pitch/2,hy=yaw/2;
  world.set(camera,Transform,{pos,quat:[Math.sin(hp)*Math.cos(hy),Math.cos(hp)*Math.sin(hy),-Math.sin(hp)*Math.sin(hy),Math.cos(hp)*Math.cos(hy)]}).unwrap();
  const rect=target.getBoundingClientRect();world.set(camera,Camera,{...perspective({fov:35*Math.PI/180,aspect:rect.width/Math.max(1,rect.height),near:.01,far:100,autoAspect:false}),clearColor:[0,0,0,0]}).unwrap();
 }
 return {camera,members,place,battle,inspect,dispose(){hideGun();if(next?.parentNode===origin)origin.insertBefore(canvas,next);else origin.appendChild(canvas);if(originalStyle===null)canvas.removeAttribute('style');else canvas.setAttribute('style',originalStyle);for(const handle of [...models.values(),...guns.values()])world.sharedRefs.release(handle).unwrap();}};
}
