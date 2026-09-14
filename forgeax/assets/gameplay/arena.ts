import type {World,EntityHandle} from '@forgeax/engine/ecs';
import type {GameHost} from '@forgeax/engine/app';
import {Transform} from '@forgeax/engine/scene';
import {MeshFilter,MeshRenderer} from '@forgeax/engine/render';
import {createBoxGeometry} from '@forgeax/engine/geometry';
import type {MeshAsset,Handle} from '@forgeax/engine/types';
import {modelGuid,smallTerrainMaterialGuid} from '../identity.ts';
import {spawnActor,type ActorEntity} from './actor-entity.ts';
import type {VoxelMap,Vec3} from './voxel-map.ts';
import {paramsFor,original,type ModeId} from './catalog.ts';
import * as math from '../original/math.ts';
import {installOriginalAI} from '../original/small-ai.ts';
import {installTdmMatch} from '../original/tdm-match.ts';
import {installFfaMatch} from '../original/ffa-match.ts';
import {installGgMatch} from '../original/gg-match.ts';
import {installTdmSpawn} from '../original/tdm-spawn.ts';
import {installFfaSpawn} from '../original/ffa-spawn.ts';
export interface CombatPort {camera:EntityHandle;weaponId:string;map:VoxelMap;elapsed:number;health:number;armor:number;dead:boolean;spawnProtection:number;spawn:Vec3;setWeapon(id:string,refill:boolean):void;respawn(pos:Vec3):void;notice(message:string):void;leave():void;ammoState:Record<string,{mag:number;reserve:number}>}
export async function createArena(world:World,host:GameHost,mode:ModeId,source:any,combat:CombatPort,cancelled:()=>boolean){
 const owned=new Set<EntityHandle>(),handles:Handle<'MeshAsset','shared'>[]=[],models=new Map<string,Handle<'MeshAsset','shared'>>();
 const effects:{entity:EntityHandle;v:Vec3;life:number}[]=[];const corpses:{entity:EntityHandle;life:number}[]=[];const delayed:{at:number;callback:()=>void}[]=[];
 let closed=false;const destroy=(entity:EntityHandle)=>{if(owned.delete(entity))world.despawn(entity).unwrap();};
 function dispose(){if(closed)return;closed=true;for(const e of [...owned])destroy(e);for(const h of handles)world.sharedRefs.release(h).unwrap();handles.length=0;effects.length=0;corpses.length=0;delayed.length=0;}
 try{
 for(const variant of ['ally','enemy','enemy_heavy','enemy_ranged']){const loaded=await host.assets.loadByGuid<MeshAsset>(modelGuid('soldier/small/ai/'+variant));if(!loaded.ok)throw loaded.error;if(cancelled())throw Error('对局载入已取消');const h=world.allocSharedRef('MeshAsset',loaded.value);handles.push(h);models.set(variant,h);}
 const cube={...createBoxGeometry(.16,.16,.16).unwrap(),materialSlots:[{slotName:'body',defaultMaterial:smallTerrainMaterialGuid(5)}]};const chunk=world.allocSharedRef('MeshAsset',cube);handles.push(chunk);
 let rng=source.seed>>>0;const random=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng/4294967296;};const seededMath=Object.create(Math);seededMath.random=random;
 const scene={add:(node:ActorEntity)=>{node.visible=true;},remove:(node:ActorEntity)=>destroy(node.entity)};
 const visual={hit:(unit:any,amount:number)=>{if(amount<=0)return;const p=unit.mesh.position;const entity=world.spawn({component:Transform,data:{pos:[p.x,p.y+1.2,p.z],scale:[.6,.6,.6]}},{component:MeshFilter,data:{assetHandle:chunk}},{component:MeshRenderer,data:{materials:[]}}).unwrap();owned.add(entity);effects.push({entity,v:[random()-.5,2,random()-.5],life:.16});},death:(unit:any,direction:any)=>{const p=unit.mesh.position.clone();unit.mesh.visible=false;corpses.push({entity:unit.mesh.entity,life:2});for(let i=0;i<35&&effects.length<280;i++){const entity=world.spawn({component:Transform,data:{pos:[p.x+(random()-.5)*.65,p.y+random()*1.7,p.z+(random()-.5)*.4]}},{component:MeshFilter,data:{assetHandle:chunk}},{component:MeshRenderer,data:{materials:[]}}).unwrap();owned.add(entity);effects.push({entity,v:[(random()-.5)*4+(direction?.x||0)*3,2+random()*5,(random()-.5)*4+(direction?.z||0)*3],life:.8+random()*.7});}},update:(dt:number)=>{for(let i=effects.length-1;i>=0;i--){const fx=effects[i];fx.life-=dt;if(fx.life<=0){destroy(fx.entity);effects.splice(i,1);continue;}fx.v[1]-=24*dt;const t=world.get(fx.entity,Transform).unwrap();world.set(fx.entity,Transform,{pos:[t.pos[0]+fx.v[0]*dt,t.pos[1]+fx.v[1]*dt,t.pos[2]+fx.v[2]*dt],scale:[Math.min(1,fx.life*3),Math.min(1,fx.life*3),Math.min(1,fx.life*3)]}).unwrap();}},clear:()=>{for(const f of effects)destroy(f.entity);effects.length=0;}};
 const map=combat.map;let selected:any=null;const worldPort:any={worldSize:map.width,height:map.height,buildings:source.buildings,props:[],ziplines:[],_playerTeam:'ally',_allyBasePos:new math.Vector3(source.bases[0].x,source.bases[0].y,source.bases[0].z),_enemyBasePos:new math.Vector3(source.bases[1].x,source.bases[1].y,source.bases[1].z),_plannedLandmarks:source.landmarks,_tdmArenaCenter:source.center,_tdmArenaRadius:source.radius,get:(x:number,y:number,z:number)=>map.get(x,y,z),_isSolid:(x:number,y:number,z:number)=>map.solid(x,y,z),getWalkHeight:(x:number,z:number)=>map.walkHeight(x,z),overlapsSolid:(box:any)=>{for(let x=Math.floor(box.min.x);x<=Math.floor(box.max.x);x++)for(let y=Math.floor(box.min.y);y<=Math.floor(box.max.y);y++)for(let z=Math.floor(box.min.z);z<=Math.floor(box.max.z);z++)if(map.solid(x,y,z))return true;return false;},getTdmSpawnZones:()=>source.zones,setSelectedSpawn:(id:string)=>{selected=source.zones.find((z:any)=>z.id===id)||null;},setTdmSpawnOverride:(zone:any)=>{selected=zone;}};
 const player:any={isPlayer:true,team:'ally',maxHealth:100,object:{position:new math.Vector3()},getEyePosition:()=>{const p=world.get(combat.camera,Transform).unwrap().pos;return new math.Vector3(...p);}};
 for(const key of ['health','armor','dead'] as const)Object.defineProperty(player,key,{get:()=>combat[key],set:(v:any)=>{(combat as any)[key]=v;}});Object.defineProperty(player,'alive',{get:()=>!combat.dead});Object.defineProperty(player,'spawnProtect',{get:()=>combat.spawnProtection,set:(v:number)=>{combat.spawnProtection=v;}});
 let match:any,spawn:any,ai:any;
 const game:any={player,world:worldPort,mode:'pve',running:true,resumeAfterRedeploy:()=>combat.respawn(selected?[selected.x,selected.y,selected.z]:combat.spawn),returnFromMatch:()=>combat.leave(),weapons:{get current(){return combat.weaponId;},state:combat.ammoState,forceEquip:(id:string)=>combat.setWeapon(id,true)}};
 const env:any={setTimeout:(callback:()=>void,milliseconds:number)=>{delayed.push({at:combat.elapsed+milliseconds/1000,callback});},VF:{game,WEAPONS:original.small.weapons,BLOCK:original.small.blocks,Feel:original.small.feel,GameModes:{getParams:(id:ModeId)=>paramsFor(id),param:(key:string,fallback:any)=>paramsFor(mode)[key]??fallback,isTdm:()=>mode==='tdm',isFfa:()=>mode==='ffa',isGg:()=>mode==='gungame',isTeamless:()=>mode==='ffa'||mode==='gungame',prepFrozen:()=>!match?.scoringLive()},Soldier:{createSoldier:(id:string)=>{const node=spawnActor(world,models.get(id)!,'AI '+id);owned.add(node.entity);return node;}},UI:{toast:(message:string)=>combat.notice(message),isMenuOpen:()=>false}}};
 match=mode==='tdm'?installTdmMatch(env):mode==='gungame'?installGgMatch(env):installFfaMatch(env);spawn=mode==='tdm'?installTdmSpawn(env):installFfaSpawn(env);
 // Original simulation uses only value math; the supplied clock advances with World Time.
 const AI=installOriginalAI(env,visual,{now:()=>combat.elapsed*1000},seededMath,math);ai=new AI(scene,worldPort,player);game.ai=ai;
 player.takeDamage=(amount:number,_from:any,attacker:any,opts:any)=>{if(combat.dead||combat.spawnProtection>0||!match.scoringLive())return true;let damage=Math.max(0,amount);if(!opts?.ignoreArmor){const absorb=Math.min(combat.armor,damage*.55);combat.armor-=absorb;damage-=absorb;}const applied=Math.min(combat.health,damage);combat.health=Math.max(0,combat.health-damage);match.registerDamage(player,applied,attacker);if(combat.health<=0){combat.dead=true;match.registerKill({victim:player,killer:attacker,headshot:!!opts?.headshot,maxHp:100});spawn.onPlayerDeath();return false;}return true;};
 // HUD updates are data publications; UiAsset rendering remains in its owner plugin.
 env.VF.UI.updateArmyCounts=(blue:number,red:number)=>{counts=[blue,red];};env.VF.UI.updateSquad=(allies:number,enemies:number)=>{squadCounts=[allies,enemies];};
 let counts=[0,0],squadCounts=[0,0];match.start();spawn.start();ai.applyPlayerTeam();
 function update(dt:number){if(closed)return;for(let i=delayed.length-1;i>=0;i--)if(delayed[i].at<=combat.elapsed){const [{callback}]=delayed.splice(i,1);callback();}for(let i=corpses.length-1;i>=0;i--){corpses[i].life-=dt;if(corpses[i].life<=0){destroy(corpses[i].entity);corpses.splice(i,1);}}const p=world.get(combat.camera,Transform).unwrap().pos;player.object.position.set(p[0],p[1]-1.8,p[2]);combat.spawnProtection=Math.max(0,combat.spawnProtection-dt);match.update(dt);if(closed)return;if(!match.ended){ai.update(dt);spawn.update(dt);}else visual.update(dt);}
 function hit(origin:Vec3,direction:Vec3,range:number,damage:number,weaponId:string){const o=new math.Vector3(...origin),d=new math.Vector3(...direction),result=ai.raycastEnemies(o,d,range);if(!result)return null;const relativeY=result.point.y-result.enemy.mesh.position.y;ai.damageEnemy(result.enemy,damage,d,{headshot:relativeY>1.6,weaponId});return result.dist;}
 return {update,hit,match,spawn,ai,env,dispose,get counts(){return counts;},get squadCounts(){return squadCounts;}};
 }catch(error){dispose();throw error;}
}
