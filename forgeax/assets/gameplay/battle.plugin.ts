import {classArmor,weaponClassSpeed} from './class-skill-rules.ts';
import {createMatchInspect} from './match-inspect.ts';
import {quatXYZ} from './melee-rules.ts';
import gadgetPoses from '../original/gadget-poses.ts';
import {fireGun,type GunshotRecord} from './native-gunfire.ts';
import {createEquipment,type EquipmentAssets} from './native-equipment.ts';
import {carrySnapshot} from './equipment-rules.ts';
import {PhysicsStepSimulation} from '@forgeax/engine/physics-rapier3d';
import {createBattleAudio} from './native-audio.ts';
import {createSkills} from './native-skills.ts';
import {createOrdnance} from './native-ordnance.ts';
import {createBuilding} from './native-building.ts';
import {createVehicles} from './native-vehicles.ts';
import type {} from '@forgeax/engine/app';
import type {Plugin} from '@forgeax/engine/plugin';
import {Update,FixedUpdate,Time,type EntityHandle} from '@forgeax/engine/ecs';
import {Transform,Name,ChildOf,sceneEntity,worldResolveSceneEntity} from '@forgeax/engine/scene';
import {Camera,MeshFilter,MeshRenderer,perspective,setActiveCamera,Skylight,Visibility,VisibilityStateValue} from '@forgeax/engine/render';
import {getState,setNextState} from '@forgeax/engine/state';
import {Screen,type Session} from './state.ts';
import {VoxelMap,inflateBase64,type Vec3} from './voxel-map.ts';
import {weaponsFor,original,runtimeFor,type Weapon,type ModeId,type Loadout} from './catalog.ts';
import {equipmentGuid,terrainMaterialGuid,smallTerrainMaterialGuid,throwableFxGuid} from '../identity.ts';
import type {MaterialAsset,MeshAsset} from '@forgeax/engine/types';
import colors from '../original/terrain-colors.ts';
import smallColors from '../original/small-terrain-colors.ts';
import {createNativeArena,type NativeCombatPort} from './native-arena.ts';
import {NativePhysics} from './native-physics.ts';
import type {AssetGuid} from '@forgeax/engine/pack/guid';
export const BATTLE_RUNTIME='voxel-frontline/battle-runtime';
export const BATTLE='voxel-frontline/battle';
export type BattleState={downed?:boolean;inspect?:ReturnType<typeof createMatchInspect>;lastGunshot?:GunshotRecord;mode:ModeId;gear?:ReturnType<typeof createEquipment>;lastHurt?:number;audio?:Awaited<ReturnType<typeof createBattleAudio>>;skills?:ReturnType<typeof createSkills>;deployables:any[];classId:string;grenades:number;skillCooldown:number;stealthUntil:number;shieldUntil:number;shieldHealth:number;bonusShot:number;speedBoostUntil:number;ordnance?:ReturnType<typeof createOrdnance>;buildBlocks:number;buildCores:number;building?:ReturnType<typeof createBuilding>;vehicles?:Awaited<ReturnType<typeof createVehicles>>;physics:NativePhysics;playerBody:EntityHandle;interacting:boolean;equipment:Readonly<Loadout>;material:(id:number)=>AssetGuid;health:number;armor:number;dead:boolean;spawnProtection:number;spawn:Vec3;weaponId:string;ammoState:Record<string,{mag:number;reserve:number}>;arena?:Awaited<ReturnType<typeof createNativeArena>>;notice:string;noticeLeft:number;map:VoxelMap;camera:EntityHandle;chunks:Map<string,EntityHandle>;emptyChunks:Set<string>;pending:string[];keys:Set<string>;yaw:number;pitch:number;velocityY:number;grounded:boolean;weapon:Weapon;mag:number;reserve:number;reload:number;cooldown:number;firing:boolean;ads:boolean;shots:number;broken:number;elapsed:number;ready:boolean};
export interface BattleRuntime{start(session:Session):Promise<void>;stop():void;lock():void}
const plugin:Plugin={name:'voxel-frontline/battle',inject:['world','gameHost','physics'],apply(ctx){
 const host=ctx.gameHost!;let active:BattleState|null=null,epoch=0,disposed=false,starting=false;
 let farEntity:EntityHandle|undefined,farCenter='';let gunRig:EntityHandle|undefined,leftArmEntity:EntityHandle|undefined;let armsEntity:EntityHandle|undefined;let weaponEntity:EntityHandle|undefined;const stealthArms=new Map<EntityHandle,{normal:any;ghost:any}>();const gunHandles=new Map<string,Parameters<typeof ctx.world.sharedRefs.release>[0]>();const owned=new Set<EntityHandle>();const materials:Parameters<typeof ctx.world.sharedRefs.release>[0][]=[];
 const camera=()=>worldResolveSceneEntity(ctx.world,host.defaultSceneRoot!,sceneEntity('scene/deployment','camera')).unwrap();
 const position=(e:EntityHandle)=>Array.from(ctx.world.get(e,Transform).unwrap().pos) as Vec3;
 function publish(s:BattleState){ctx.world.insertResource(BATTLE,s);}
 function stop(){epoch++;starting=false;active?.inspect?.dispose();active?.audio?.dispose();active?.gear?.dispose();active?.skills?.dispose();active?.ordnance?.dispose();active?.vehicles?.dispose();active?.arena?.dispose();active?.physics.dispose();armsEntity=undefined;leftArmEntity=undefined;gunRig=undefined;weaponEntity=undefined;gunHandles.clear();stealthArms.clear();if(document.pointerLockElement===host.canvas)document.exitPointerLock();for(const e of owned)ctx.world.despawn(e).unwrap();owned.clear();farEntity=undefined;farCenter='';for(const h of materials)ctx.world.sharedRefs.release(h).unwrap();materials.length=0;active=null;ctx.world.removeResource(BATTLE);}
 function lock(){if(!active||getState(ctx.world,Screen).unwrap()!=='battle')return;try{const p=host.canvas.requestPointerLock();p?.catch(()=>{});}catch{}}
 function buildChunk(s:BattleState,key:string){
  const [cx,cz]=key.split(',').map(Number),mesh=s.map.buildChunk(cx,cz,s.material),old=s.chunks.get(key);
  if(old!==undefined){ctx.world.despawn(old).unwrap();owned.delete(old);s.chunks.delete(key);}if(!mesh){s.emptyChunks.add(key);return;}s.emptyChunks.delete(key);
  const handle=ctx.world.allocSharedRef('MeshAsset',mesh);const e=ctx.world.spawn({component:Transform,data:{}},{component:Name,data:{value:'地形区块 '+key}},{component:MeshFilter,data:{assetHandle:handle}},{component:MeshRenderer,data:{materials:[]}}).unwrap();ctx.world.sharedRefs.release(handle).unwrap();s.chunks.set(key,e);owned.add(e);
 }
 function stream(s:BattleState){const p=position(s.camera),cx=Math.floor(p[0]/16),cz=Math.floor(p[2]/16),wanted=new Set<string>(),list:{key:string;distance:number}[]=[];
  if(farCenter!==cx+','+cz){if(farEntity!==undefined){ctx.world.despawn(farEntity).unwrap();owned.delete(farEntity);}const mesh=s.map.buildFarTerrain(cx,cz,s.material),handle=ctx.world.allocSharedRef('MeshAsset',mesh);farEntity=ctx.world.spawn({component:Transform,data:{}},{component:MeshFilter,data:{assetHandle:handle}},{component:MeshRenderer,data:{materials:[]}}).unwrap();ctx.world.sharedRefs.release(handle).unwrap();owned.add(farEntity);farCenter=cx+','+cz;}
  for(let x=cx-4;x<=cx+4;x++)for(let z=cz-4;z<=cz+4;z++){if(x<0||z<0||x>=s.map.width/16||z>=s.map.width/16)continue;const key=x+','+z;wanted.add(key);if(!s.chunks.has(key)&&!s.emptyChunks.has(key)||s.map.dirty.has(key))list.push({key,distance:(x-cx)**2+(z-cz)**2});}
  for(const [key,e] of s.chunks)if(!wanted.has(key)){ctx.world.despawn(e).unwrap();s.chunks.delete(key);owned.delete(e);}
  for(const key of s.emptyChunks)if(!wanted.has(key))s.emptyChunks.delete(key);
  s.pending=list.sort((a,b)=>a.distance-b.distance).map(x=>x.key);const until=performance.now()+6;do{const key=s.pending.shift();if(key===undefined)break;buildChunk(s,key);s.map.dirty.delete(key);}while(performance.now()<until);
 }
 async function start(session:Session){
  if(starting)throw Error('战场正在载入');
  stop();starting=true;const ticket=epoch;
  try{
   const source:any=session.mode==='conquest'?(await import('../original/conquest-map.ts')).default:session.mode==='core'?(await import('../original/core-map.ts')).default:session.mode==='demo'?(await import('../original/demo-map.ts')).default:session.mode==='tdm'?(await import('../original/tdm-map.ts')).default:(await import('../original/ffa-map.ts')).default;
   const small=runtimeFor(session.mode)==='small',materialGuid=small?smallTerrainMaterialGuid:terrainMaterialGuid;
   const [blocks,ground,terrain]=await Promise.all([inflateBase64(source.blocksGzip,source.width*source.width*source.height),inflateBase64(source.groundGzip,source.width*source.width),inflateBase64(source.terrainGzip,source.width*source.width*4)]);
   if(disposed||ticket!==epoch)throw Error('战场载入已取消');
   const map=new VoxelMap(source.width,source.height,blocks,new Int8Array(ground.buffer as ArrayBuffer),new Float32Array(terrain.buffer as ArrayBuffer),source.hits);
   for(const id of Object.keys(small?smallColors:colors)){const material=await host.assets.loadByGuid<MaterialAsset>(materialGuid(Number(id)));if(!material.ok)throw material.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');materials.push(ctx.world.allocSharedRef('MaterialAsset',material.value));}
   const base=source.bases[0],eye:Vec3=[base.x,(base.y??map.ground[Math.floor(base.z)*map.width+Math.floor(base.x)]+1)+1.8,base.z];const c=camera();
   ctx.world.set(c,Transform,{pos:eye,quat:[0,1,0,0]}).unwrap();ctx.world.set(c,Camera,{...perspective({fov:70*Math.PI/180,aspect:innerWidth/innerHeight,near:.08,far:1100}),clearColor:[.208,.468,.776,1]}).unwrap();setActiveCamera(ctx.world,c);
   const ambient=ctx.world.spawn({component:Skylight,data:{color:[.658,.761,.888],intensity:.62}}).unwrap();owned.add(ambient);
   const loadout=carrySnapshot(session.mode,session.loadouts[runtimeFor(session.mode)]),available=weaponsFor(session.mode),primary=session.mode==='gungame'?'ar':loadout.primary;
   const weapon=available[primary];if(!weapon)throw Error('无效的主武器');
   const weaponModels=small?Object.keys(available):[...new Set([loadout.primary,loadout.secondary,'knife',...([loadout.gadget1,loadout.gadget2].includes('rpg')?['rpg']:[])])];
   for(const id of weaponModels){const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid((small?'small/':'')+'gun/'+id));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');const handle=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(handle);gunHandles.set(id,handle);}
   const equipmentAssets:EquipmentAssets=new Map();
   if(!small)for(const key of ['medkit','ammo','charge','remote','binoculars','knife','knife-slash','knife-guard',loadout.grenade]){const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid('gadget/'+session.classId+'/'+key));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');const handle=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(handle);equipmentAssets.set('gadget/'+key,handle);}
   if(small)for(const key of [loadout.grenade,'knife','knife-slash','knife-guard',...(session.classId==='vanguard'?['charge']:[])]){const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid('small/gadget/'+session.classId+'/'+key));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');const h=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(h);equipmentAssets.set('gadget/'+key,h);}
   {const key=loadout.grenade,asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid((small?'small/':'')+'projectile/'+key));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');const h=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(h);equipmentAssets.set('projectile/'+key,h);}
   for(const key of small?(session.classId==='vanguard'?['charge']:[]):['medkit','ammo','charge']){const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid((small?'small/':'')+'deployed/'+key));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');const handle=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(handle);equipmentAssets.set('deployed/'+key,handle);}
   for(const key of ['melee-hit','melee-backstab']){const mat=await host.assets.loadByGuid<MaterialAsset>(equipmentGuid('effect/'+key+'-material'));if(!mat.ok)throw mat.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');materials.push(ctx.world.allocSharedRef('MaterialAsset',mat.value));const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid('effect/'+key));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');const h=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(h);equipmentAssets.set('effect/'+key,h);}
   const armKey=small?'small/arms/'+session.classId+'/right':'arms/ally/'+session.classId;
   for(const key of ['smoke-low','smoke-mid','smoke-high','fire','ember','flash','stun','char']){const loaded=await host.assets.loadByGuid<MaterialAsset>(throwableFxGuid(key));if(!loaded.ok)throw loaded.error;if(disposed||ticket!==epoch)throw Error('特效载入已取消');materials.push(ctx.world.allocSharedRef('MaterialAsset',loaded.value));}
   const arms=await host.assets.loadByGuid<MeshAsset>(equipmentGuid(armKey));if(!arms.ok)throw arms.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');
   gunRig=ctx.world.spawn({component:ChildOf,data:{parent:c}},{component:Transform,data:{}}).unwrap();owned.add(gunRig);
   const leftRest=(gadgetPoses as Record<string,any>)['small/arms/'+session.classId+'/left']?.hip;
   if(small){const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid('small/arms/'+session.classId+'/left'));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('战场载入已取消');const h=ctx.world.allocSharedRef('MeshAsset',asset.value);
    leftArmEntity=ctx.world.spawn({component:ChildOf,data:{parent:gunRig}},{component:Transform,data:{pos:[leftRest.x,leftRest.y,leftRest.z],quat:quatXYZ(leftRest.rx,leftRest.ry,leftRest.rz)}},{component:MeshFilter,data:{assetHandle:h}},{component:MeshRenderer,data:{materials:[]}},{component:Visibility,data:{state:VisibilityStateValue.visible}}).unwrap();ctx.world.sharedRefs.release(h).unwrap();owned.add(leftArmEntity);
   }
   const armHandle=ctx.world.allocSharedRef('MeshAsset',arms.value);const arm=ctx.world.spawn({component:ChildOf,data:{parent:gunRig!}},{component:Transform,data:{}},{component:MeshFilter,data:{assetHandle:armHandle}},{component:MeshRenderer,data:{materials:[]}}).unwrap();ctx.world.sharedRefs.release(armHandle).unwrap();owned.add(arm);armsEntity=arm;ctx.world.addComponent(arm,{component:Visibility,data:{state:VisibilityStateValue.visible}}).unwrap();
   weaponEntity=ctx.world.spawn({component:ChildOf,data:{parent:gunRig!}},{component:Transform,data:{pos:[.35,-.39,-.62],quat:[.0518,.0785,.0289,.995]}},{component:MeshFilter,data:{assetHandle:gunHandles.get(primary)! as any}},{component:MeshRenderer,data:{materials:[]}}).unwrap();owned.add(weaponEntity);ctx.world.addComponent(weaponEntity,{component:Visibility,data:{state:VisibilityStateValue.visible}}).unwrap();
   if(small&&session.classId==='ghost'){
     for(const id of weaponModels){const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid('stealth/small/gun/'+id));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('技能载入已取消');const h=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(h);gunHandles.set('stealth/'+id,h);}
     for(const [entity,key] of [[armsEntity,armKey],[leftArmEntity,'small/arms/ghost/left']] as const){if(entity===undefined)continue;const pair:any={};for(const kind of ['normal','ghost']){const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid((kind==='ghost'?'stealth/':'')+key));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('技能载入已取消');const h=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(h);pair[kind]=h;}stealthArms.set(entity,pair);}
     for(const key of [loadout.grenade,'knife','knife-slash','knife-guard']){const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid('stealth/small/gadget/ghost/'+key));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('技能载入已取消');const h=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(h);equipmentAssets.set('stealth/gadget/'+key,h);}
    }
    for(const key of ['healer','healer-preview','shield','turret-preview','turret-base','turret-head','turret-barrels','fx']){const asset=await host.assets.loadByGuid<MeshAsset>(equipmentGuid('skill/'+key));if(!asset.ok)throw asset.error;if(disposed||ticket!==epoch)throw Error('技能载入已取消');const handle=ctx.world.allocSharedRef('MeshAsset',asset.value);materials.push(handle);equipmentAssets.set('skill/'+key,handle);}
    const ammoState:BattleState['ammoState']={};for(const [id,w] of Object.entries(available))ammoState[id]={mag:w.magSize,reserve:w.reserve};
   const physics=new NativePhysics(ctx.world,map),playerBody=physics.character([eye[0],eye[1]-1.8,eye[2]],'玩家');owned.add(playerBody);
   const s:BattleState={mode:session.mode,deployables:[],classId:session.classId,grenades:2,skillCooldown:0,stealthUntil:0,shieldUntil:0,shieldHealth:0,bonusShot:0,speedBoostUntil:0,buildBlocks:session.classId==='engineer'?20:8,buildCores:0,physics,playerBody,interacting:false,equipment:loadout,material:materialGuid,health:100,armor:50,dead:false,spawnProtection:0,spawn:[eye[0],eye[1]-1.8,eye[2]],weaponId:primary,ammoState,notice:'',noticeLeft:0,map,camera:c,chunks:new Map(),emptyChunks:new Set(),pending:[],keys:new Set(),yaw:Math.PI,pitch:0,velocityY:0,grounded:true,weapon,mag:weapon.magSize,reserve:weapon.reserve,reload:0,cooldown:0,firing:false,ads:false,shots:0,broken:0,elapsed:0,ready:false};
   Object.defineProperties(s,{mag:{get:()=>ammoState[s.weaponId].mag,set:(v:number)=>{ammoState[s.weaponId].mag=v;}},reserve:{get:()=>ammoState[s.weaponId].reserve,set:(v:number)=>{ammoState[s.weaponId].reserve=v;}}});active=s;publish(s);
   let equipWeapon:(id:string,refill:boolean)=>void=()=>{};
   {
    const callbacks={setWeapon:(id:string,refill:boolean)=>{const def=available[id],handle=gunHandles.get(id);if(!def||!handle)throw Error('未迁移武器 '+id);s.weaponId=id;s.weapon=def;s.reload=0;s.cooldown=0;if(refill){s.mag=def.magSize;s.reserve=def.reserve;}if(weaponEntity!==undefined)ctx.world.set(weaponEntity,MeshFilter,{assetHandle:handle as any}).unwrap();},respawn:(feet:Vec3)=>{s.health=100;s.armor=classArmor(s.mode,s.classId);s.dead=false;s.downed=false;s.skills?.spawnLife();s.velocityY=0;s.reload=0;s.mag=s.weapon.magSize;s.reserve=s.weapon.reserve;s.gear?.reset();ctx.world.set(c,Transform,{pos:[feet[0],feet[1]+1.8,feet[2]]}).unwrap();},notice:(message:string)=>{s.notice=message;s.noticeLeft=3;},onDeath:(p:Vec3)=>s.ordnance?.burst(p),sound:(id:string,p:Vec3)=>s.audio?.gun(id,p),explosionSound:(p:Vec3)=>s.audio?.play('throwable.frag.detonate',p),leave:()=>{setNextState(ctx.world,Screen,'modes').unwrap();stop();}};
    equipWeapon=callbacks.setWeapon;
    const bridge=new Proxy(s as any,{get:(target,key)=>key in callbacks?(callbacks as any)[key]:target[key],set:(target,key,value)=>{target[key]=value;return true;}});
    s.arena=await createNativeArena(ctx.world,host,session.mode,source,bridge as NativeCombatPort,physics,()=>disposed||ticket!==epoch);
   }
   if(session.mode==='conquest'||session.mode==='core')s.vehicles=await createVehicles(ctx.world,host,s,()=>disposed||ticket!==epoch);
   s.audio=await createBattleAudio(ctx.world,host,s,()=>disposed||ticket!==epoch);
   s.ordnance=createOrdnance(ctx.world,s);s.skills=createSkills(ctx.world,s,equipmentAssets);s.building=createBuilding(s);s.gear=createEquipment(ctx.world,s,equipmentAssets,equipWeapon);
   const showGun=(show:boolean)=>{for(const e of [armsEntity,leftArmEntity,weaponEntity])if(e!==undefined)ctx.world.set(e,Visibility,{state:show?VisibilityStateValue.visible:VisibilityStateValue.hidden}).unwrap();};
   const resetInspect=()=>{if(gunRig!==undefined)ctx.world.set(gunRig,Transform,{pos:[0,0,0],quat:[0,0,0,1]}).unwrap();if(leftArmEntity!==undefined)ctx.world.set(leftArmEntity,Transform,{pos:[leftRest.x,leftRest.y,leftRest.z],quat:quatXYZ(leftRest.rx,leftRest.ry,leftRest.rz)}).unwrap();s.gear?.inspectKnife([.3,-.34,-.52],[0,0,0,1]);const hp=s.pitch/2,hy=s.yaw/2;ctx.world.set(c,Transform,{quat:[Math.sin(hp)*Math.cos(hy),Math.cos(hp)*Math.sin(hy),-Math.sin(hp)*Math.sin(hy),Math.cos(hp)*Math.cos(hy)]}).unwrap();ctx.world.set(c,Camera,{fov:70*Math.PI/180}).unwrap();};
   s.inspect=createMatchInspect(s,(pose,melee)=>{
    showGun(!melee);if(melee)s.gear?.inspectKnife(pose.pos,pose.quat);else if(gunRig!==undefined)ctx.world.set(gunRig,Transform,{pos:pose.gunRigPos,quat:pose.quat}).unwrap();
    if(!melee&&leftArmEntity!==undefined)ctx.world.set(leftArmEntity,Transform,{pos:[leftRest.x,leftRest.y+pose.left.y,leftRest.z+pose.left.z],quat:quatXYZ(leftRest.rx+pose.left.rx,leftRest.ry,leftRest.rz+pose.left.rz)}).unwrap();
    const x=(s.pitch+pose.pitch)/2,y=(s.yaw+pose.yaw)/2,z=pose.roll/2,sx=Math.sin(x),sy=Math.sin(y),sz=Math.sin(z),cx=Math.cos(x),cy=Math.cos(y),cz=Math.cos(z),p=s.physics.position(s.playerBody);
    ctx.world.set(c,Transform,{pos:[p[0],p[1]+.9,p[2]],quat:[sx*cy*cz+cx*sy*sz,cx*sy*cz-sx*cy*sz,cx*cy*sz-sx*sy*cz,cx*cy*cz+sx*sy*sz]}).unwrap();ctx.world.set(c,Camera,{fov:pose.fov*Math.PI/180}).unwrap();
   },resetInspect,()=>ctx.world.get(c,Camera).unwrap().fov*180/Math.PI);stream(s);s.ready=true;
  }catch(e){if(ticket===epoch)stop();throw e;}finally{if(ticket===epoch)starting=false;}
 }
 ctx.world.replaceSystem(FixedUpdate,PhysicsStepSimulation.name,{...PhysicsStepSimulation,runIf:()=>!active||getState(ctx.world,Screen).unwrap()==='battle'&&!active.inspect?.blocksSimulation}).unwrap();
 const runtime:BattleRuntime={start,stop,lock};ctx.world.insertResource(BATTLE_RUNTIME,runtime);
 const keydown=(e:KeyboardEvent)=>{
  const s=active;if(!s||getState(ctx.world,Screen).unwrap()!=='battle'||(e.target as Element)?.matches('input,textarea'))return;
  if(s.inspect?.blocksInput)return;
  s.keys.add(e.code);if(['Space','Tab'].includes(e.code))e.preventDefault();if(e.repeat||s.dead)return;if(['KeyX','KeyG','KeyQ','KeyV'].includes(e.code)&&document.pointerLockElement!==host.canvas)return;
  if(s.vehicles?.seated){if(e.code==='KeyR')s.vehicles.reload();if(e.code==='KeyQ')s.vehicles.cycleWeapon();if(e.code==='KeyC')s.vehicles.cycleSeat();if(e.code==='KeyF')s.vehicles.interact();return;}
  if(e.code==='KeyV'){s.skills?.dash();return;}if(e.code==='KeyX'&&s.mode==='conquest'){s.skills?.activate();return;}if(e.code==='KeyQ'&&s.mode==='conquest'){s.skills?.mark();return;}
   if(s.gear?.key(e.code))return;
  if(e.code==='KeyG'&&s.mode!=='conquest')s.skills?.activate();
  if(s.mode==='core'&&(e.code==='Digit4'||e.code==='Digit5')){s.gear?.cancel();s.building?.select(e.code==='Digit4'?'cover':'tower');return;}
  if(e.code==='KeyF'&&!s.arena?.useZipline()){s.gear?.cancel();s.vehicles?.interact();}

  if(e.code==='KeyR'&&s.building?.active){s.building.rotate();return;}
  if(e.code==='KeyR'&&!s.skills?.channeling&&!s.skills?.aiming&&!s.skills?.dashing&&s.gear?.inventory.gun&&!s.gear.busy&&s.reload===0&&s.mag<s.weapon.magSize&&s.reserve>0){s.reload=s.weapon.reloadTime/weaponClassSpeed(s.mode,s.classId);s.audio?.play('weapon.mechanic.reload_start');}
 };
 const keyup=(e:KeyboardEvent)=>{const s=active;s?.keys.delete(e.code);if(!s)return;if(e.code===(s.mode==='conquest'?'KeyG':'KeyQ'))s.gear?.releaseQuick();if(e.code===(s.mode==='conquest'?'KeyX':'KeyG'))s.skills?.release();};
 const mousemove=(e:MouseEvent)=>{const s=active;if(!s||s.inspect?.blocksInput||document.pointerLockElement!==host.canvas)return;const sensitivity=(s.ads?.0011:.0022)*(s.gear?.turnScale??1);s.yaw-=e.movementX*sensitivity;s.pitch=Math.max(-1.5,Math.min(1.5,s.pitch-e.movementY*sensitivity));};
 const mousedown=(e:MouseEvent)=>{if(!active||active.inspect?.blocksInput||getState(ctx.world,Screen).unwrap()!=='battle')return;const path=e.composedPath();if(path.some(n=>n instanceof Element&&n.closest('button,input,select,[data-combat-slot]')))return;if(document.pointerLockElement!==host.canvas){lock();return;}if(active.skills?.channeling||active.skills?.aiming||active.skills?.dashing)return;if(e.button===0){if(active.building?.active){active.building.place();return;}if(!active.gear?.press())active.firing=true;}if(e.button===2&&!active.gear?.secondary()&&active.gear?.canAds)active.ads=true;};
 const mouseup=(e:MouseEvent)=>{if(!active)return;if(e.button===0){active.firing=false;active.gear?.release();}if(e.button===2)active.ads=false;};
 const blur=()=>{if(active){active.keys.clear();active.firing=false;active.ads=false;active.gear?.cancel();active.skills?.cancel();}};
 const lockChange=()=>{if(document.pointerLockElement!==host.canvas)blur();};
 const contextmenu=(e:Event)=>{if(active&&getState(ctx.world,Screen).unwrap()==='battle')e.preventDefault();};
 const stopRead=host.gameProjection?.registerRead({id:'frontline.battle',title:'对局状态',description:'只读：当前造化实体与原版规则的状态',read:()=>active?{inspect:active.inspect?.snapshot()??null,equipment:active.gear?.snapshot()??null,mode:active.mode,elapsed:active.elapsed,health:active.health,shots:active.shots,brokenBlocks:active.broken,nativeEntities:owned.size,physicsBodies:active.physics.backend.getBodyCount(),playerPosition:active.physics.position(active.playerBody),objectives:active.arena?.objectives.map(o=>({...o}))||[],bomb:active.arena?.bomb?.snapshot()||null,chunks:active.chunks.size,combatants:active.arena?active.arena.ai.blue.concat(active.arena.ai.red).filter((u:any)=>u.alive).map((u:any)=>({id:u.id,hp:u.hp,team:u.team,position:[u.mesh.position.x,u.mesh.position.y,u.mesh.position.z]})):[]}:null});
 const frame='voxel-frontline/battle-update';
 ctx.world.addSystem(Update,{name:frame,queries:[],fn:world=>{
  const s=active;if(!s||!s.ready)return;const screen=getState(world,Screen).unwrap();s.audio?.pause(screen!=='battle');if(screen!=='battle'){blur();return;}const dt=world.getResource(Time).delta;if(s.inspect?.update(dt)){s.audio?.update(dt);stream(s);return;}s.elapsed+=dt;s.audio?.update(dt);s.noticeLeft=Math.max(0,s.noticeLeft-dt);s.arena?.update(dt);if(active!==s)return;if(s.inspect?.update(0)){stream(s);return;}s.skillCooldown=Math.max(0,s.skillCooldown-dt);s.skills?.update(dt);s.ordnance?.update(dt);s.vehicles?.update(dt);s.gear?.update(dt);s.physics.around(s.physics.position(s.playerBody));s.physics.flush();if(s.classId==='ghost'&&s.mode!=='conquest'){const stealth=s.stealthUntil>s.elapsed;for(const [e,pair] of stealthArms)world.set(e,MeshFilter,{assetHandle:stealth?pair.ghost:pair.normal}).unwrap();if(weaponEntity!==undefined)world.set(weaponEntity,MeshFilter,{assetHandle:gunHandles.get((stealth?'stealth/':'')+s.weaponId) as any}).unwrap();}for(const e of [armsEntity,leftArmEntity,weaponEntity])if(e!==undefined)world.set(e,Visibility,{state:s.vehicles?.seated||s.building?.active||s.gear&&!s.gear.gunVisible?VisibilityStateValue.hidden:VisibilityStateValue.visible}).unwrap();if(s.dead||(s.arena&&!s.arena.match.scoringLive())){s.firing=false;if(!s.downed)s.keys.clear();stream(s);return;}s.cooldown=Math.max(0,s.cooldown-dt);
  if(s.reload>0){s.reload=Math.max(0,s.reload-dt);if(s.reload===0){const amount=Math.min(s.weapon.magSize-s.mag,s.reserve);s.mag+=amount;s.reserve-=amount;s.audio?.play('weapon.mechanic.reload_rack');}}
  const p=position(s.camera),feet:Vec3=[p[0],p[1]-1.8,p[2]],keys=s.keys;const forward=Number(keys.has('KeyW'))-Number(keys.has('KeyS')),right=Number(keys.has('KeyD'))-Number(keys.has('KeyA')),length=Math.max(1,Math.hypot(forward,right));
  const speed=8.5*(s.gear?.movementScale??1)*(s.stealthUntil>s.elapsed?1.3:s.shieldUntil>s.elapsed&&s.shieldHealth>0?.65:s.speedBoostUntil>s.elapsed?1.2:1)*(keys.has('ShiftLeft')?1.42:1)*(keys.has('ControlLeft')?.48:1),dx=(-Math.sin(s.yaw)*forward+Math.cos(s.yaw)*right)/length*speed*dt,dz=(-Math.cos(s.yaw)*forward-Math.sin(s.yaw)*right)/length*speed*dt;
  if(keys.has('Space')&&s.grounded){s.velocityY=8.2;s.grounded=false;s.audio?.play('character.jump');}s.velocityY-=22*dt;
  if(!s.vehicles?.seated&&!s.arena?.traversingPlayer&&!s.skills?.dashing&&!s.skills?.channeling)s.physics.move(s.playerBody,s.interacting?[0,-dt,0]:[dx+(s.skills?.impulse[0]??0)*dt,s.velocityY*dt,dz+(s.skills?.impulse[2]??0)*dt]);const resolved=s.physics.position(s.playerBody);feet[0]=resolved[0];feet[1]=resolved[1]-.9;feet[2]=resolved[2];s.grounded=s.physics.grounded(s.playerBody);if(s.grounded)s.velocityY=0;
  const shake=(s.gear?.cameraShake??0)+(s.gear?.melee.shake??0),hp=(s.pitch+(s.gear?.melee.kick??0)*.55+Math.sin(s.elapsed*39)*shake*.045)/2,hy=(s.yaw+Math.cos(s.elapsed*31)*shake*.035)/2;world.set(s.camera,Transform,{pos:s.vehicles?.camera()||[feet[0],feet[1]+1.8,feet[2]],quat:[Math.sin(hp)*Math.cos(hy),Math.cos(hp)*Math.sin(hy),-Math.sin(hp)*Math.sin(hy),Math.cos(hp)*Math.cos(hy)]}).unwrap();world.set(s.camera,Camera,{fov:((s.ads?s.gear?.adsFov??48:70)-(s.skills?.fovKick??0))*Math.PI/180}).unwrap();
  fireGun(s);
  stream(s);
 }}).unwrap();
 const listeners:[string,EventListener][]=[['keydown',keydown as EventListener],['keyup',keyup as EventListener],['mousemove',mousemove as EventListener],['mousedown',mousedown as EventListener],['mouseup',mouseup as EventListener],['pointerlockchange',lockChange],['contextmenu',contextmenu]];for(const [event,fn] of listeners)document.addEventListener(event,fn);window.addEventListener('blur',blur);
 ctx.effect(()=>()=>{disposed=true;stopRead?.();stop();ctx.world.replaceSystem(FixedUpdate,PhysicsStepSimulation.name,PhysicsStepSimulation).unwrap();ctx.world.removeSystem(Update,frame).unwrap();ctx.world.removeResource(BATTLE_RUNTIME);for(const [event,fn] of listeners)document.removeEventListener(event,fn);window.removeEventListener('blur',blur);},'voxel-frontline/battle');
}};
export default plugin;
