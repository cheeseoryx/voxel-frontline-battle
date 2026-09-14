import type {World,EntityHandle} from '@forgeax/engine/ecs';
import type {GameHost} from '@forgeax/engine/app';
import {AudioSource,AudioListener,AUDIO_ENGINE_RESOURCE_KEY,type AudioBackend} from '@forgeax/engine/audio';
import type {AudioClipAsset,Handle} from '@forgeax/engine/types';
import {audioGuid} from '../identity.ts';
import manifest from '../original/audio-manifest.ts';
import type {BattleState} from './battle.plugin.ts';
import type {Vec3} from './voxel-map.ts';
/** ECS source lifetime and distance attenuation; the Engine Host owns decoding/playback. */
export async function createBattleAudio(world:World,host:GameHost,b:BattleState,cancelled:()=>boolean){
 const handles=new Map<string,Handle<'AudioClipAsset','shared'>>(),sources=new Map<EntityHandle,{left:number;loop:boolean}>(),loops=new Map<string,EntityHandle>();
 const backend=world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY);let disposed=false,listener=false,sequence=0,footstep=0,lastHp=b.health,lastDead=false,wasGrounded=b.grounded;
 const sounds=manifest.sounds as Record<string,any>,paths=[...new Set(Object.values(sounds).flatMap(s=>[...(s.files||[]),...(s.distantFiles||[])]))] as string[];
 function remove(e:EntityHandle){if(!sources.delete(e))return;backend.stop(e as number);world.despawn(e).unwrap();}
 function dispose(){if(disposed)return;disposed=true;for(const e of [...sources.keys()])remove(e);loops.clear();if(listener)world.removeComponent(b.camera,AudioListener).unwrap();for(const h of handles.values())world.sharedRefs.release(h).unwrap();handles.clear();}
 try{
  for(let offset=0;offset<paths.length;offset+=8){const part=paths.slice(offset,offset+8);const loaded=await Promise.all(part.map(key=>host.assets.loadByGuid<AudioClipAsset>(audioGuid(key))));for(let i=0;i<loaded.length;i++){const result=loaded[i];if(!result.ok)throw result.error;if(cancelled())throw Error('音频载入已取消');handles.set(part[i],world.allocSharedRef('AudioClipAsset',result.value));}}
  world.addComponent(b.camera,{component:AudioListener,data:{}}).unwrap();listener=true;
  const resolve=(id:string)=>{const seen=new Set<string>();while(sounds[id]?.alias&&!seen.has(id)){seen.add(id);id=sounds[id].alias;}return sounds[id];};
  function play(id:string,p?:Vec3,loopKey?:string){if(disposed)return;const s=resolve(id);if(!s?.files?.length)return;const listenerPosition=b.physics.position(b.playerBody),distance=p?Math.hypot(...p.map((n,i)=>n-listenerPosition[i])):0,max=s.maxDistance||180;if(distance>max)return;
   const files=distance>(s.distantThreshold||70)&&s.distantFiles?.length?s.distantFiles:s.files,key=files[sequence++%files.length],clip=handles.get(key);if(!clip)return;const volume=(s.gain||.7)*Math.max(0,1-distance/max)**2*.55;
   if(loopKey&&loops.has(loopKey)){world.set(loops.get(loopKey)!,AudioSource,{volume}).unwrap();return;}
   if(sources.size>=32){const oldest=[...sources].find(([,v])=>!v.loop);if(oldest)remove(oldest[0]);else return;}
   const entity=world.spawn({component:AudioSource,data:{clip,playing:true,volume,loop:!!loopKey,spatialBlend:0,bus:'sfx'}}).unwrap();sources.set(entity,{left:5,loop:!!loopKey});if(loopKey)loops.set(loopKey,entity);
  }
  function gun(id:string,p?:Vec3){const profiles=manifest.weaponProfiles as Record<string,string>,category=(b.weaponId===id?b.weapon.category:undefined),profile=profiles[id]||({ar:'rifle545',sg:'rifle762',sr:'sniperheavy',akm:'rifle762',sks:'dmr762',svd:'dmr762'} as Record<string,string>)[id]||(category==='pistol'?'pistol45':category==='sniper'?'sniperheavy':'rifle556');play('weapon.profile.'+profile+'.fire',p);}
  function update(dt:number){for(const [entity,source] of sources)if(!source.loop){source.left-=dt;if(source.left<=0)remove(entity);}if(b.health<lastHp&&!b.dead)play('character.hurt');if(b.dead&&!lastDead)play('character.death');lastHp=b.health;lastDead=b.dead;
   footstep-=dt;if(!b.dead&&!b.vehicles?.seated&&b.grounded&&['KeyW','KeyS','KeyA','KeyD'].some(k=>b.keys.has(k))&&footstep<=0){const pace=b.keys.has('ShiftLeft')?'run':b.keys.has('ControlLeft')?'crouch':'walk';play('character.footstep.'+pace);footstep=pace==='run'?.3:pace==='crouch'?.6:.43;}if(b.grounded&&!wasGrounded)play('character.land.soft');wasGrounded=b.grounded;
   const wanted=new Set<string>();for(const v of b.vehicles?.vehicles||[]){const p=b.physics.position(v.entity),distance=Math.hypot(...p.map((n,i)=>n-b.physics.position(b.playerBody)[i]));if(v.hp<=0||distance>75)continue;const key=v.id+'-'+(Math.abs(v.speed)>1?'engine':'idle');wanted.add(key);play('vehicle.'+v.type+'.'+(Math.abs(v.speed)>1?'engine':'idle'),p,key);}for(const [key,e] of loops)if(!wanted.has(key)){remove(e);loops.delete(key);}
  }
  return {play,gun,update,dispose,getState:()=>backend.getState(),pause:(paused:boolean)=>{backend.setBusMute('sfx',paused);}};
 }catch(error){dispose();throw error;}
}
