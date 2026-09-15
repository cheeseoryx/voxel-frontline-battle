import {RPG_RULES} from './launcher-rules.ts';
import type {World,EntityHandle} from '@forgeax/engine/ecs';
import {Transform} from '@forgeax/engine/scene';
import {MeshFilter,MeshRenderer} from '@forgeax/engine/render';
import {RigidBody,RigidBodyTypeValue} from '@forgeax/engine/physics';
import {createBoxGeometry} from '@forgeax/engine/geometry';
import type {Handle} from '@forgeax/engine/types';
import type {BattleState} from './battle.plugin.ts';
import {isRemoteExplosive,REMOTE_RULES,rotateYaw,surfaceQuat,rayBox} from './remote-explosives.ts';
import {vehicleDefs} from '../original/vehicle-rules.ts';
import {THROWABLE_RULES} from './throwable-rules.ts';
import type {Vec3} from './voxel-map.ts';

export type RocketImpact={kind:'world'|'unit'|'vehicle';vehicle?:NonNullable<BattleState['vehicles']>['vehicles'][number]};
export type EquipmentProjectileKind='frag'|'flash'|'smoke'|'stun'|'semtex'|'molotov'|'charge'|'rpg';
type AttachmentActor={entity:EntityHandle;alive?:boolean;hp?:number;yaw?:number};
export type EquipmentProjectile={entity:EntityHandle;kind:EquipmentProjectileKind;previous:Vec3;velocity:Vec3;admitted:boolean;landed:boolean;life:number;age:number;hp:number;bounceAt:number;attachment?:{actor:AttachmentActor;offset:Vec3;normal:Vec3};support?:Vec3;normal?:Vec3};
const fuse:Record<EquipmentProjectileKind,number>={frag:THROWABLE_RULES.frag.fuse,flash:THROWABLE_RULES.flash.fuse,stun:THROWABLE_RULES.stun.fuse,smoke:THROWABLE_RULES.smoke.fuse,semtex:Infinity,molotov:0,charge:Infinity,rpg:RPG_RULES.projectileLife};
/** Rapier advances projectiles. Swept voxel/actor queries only determine impacts;
 * no second integrator or collision response is used alongside the Engine. */
export function createEquipmentProjectiles(world:World,b:BattleState,assets:Map<string,Handle<'MeshAsset','shared'>>,onEffect:(kind:EquipmentProjectileKind,p:Vec3,impact?:RocketImpact)=>void){
 const owned=new Set<EntityHandle>(),parts:EquipmentProjectile[]=[];
 const mesh=world.allocSharedRef('MeshAsset',{...createBoxGeometry(.18,.24,.18).unwrap(),materialSlots:[{slotName:'body',defaultMaterial:b.material(7)}]});
 const rocketMesh=world.allocSharedRef('MeshAsset',{...createBoxGeometry(.12,.12,.45).unwrap(),materialSlots:[{slotName:'body',defaultMaterial:b.material(7)}]});
 let closed=false;
 let lastRocket:{phase:'flight'|'impact'|'expired';position:Vec3;age:number;hit?:RocketImpact['kind']}|null=null;
 const handle=(kind:EquipmentProjectileKind)=>assets.get((kind==='charge'?'deployed/':'projectile/')+kind)||(kind==='rpg'?rocketMesh:mesh);
 function remove(part:EquipmentProjectile){const i=parts.indexOf(part);if(i<0)return;parts.splice(i,1);world.despawn(part.entity).unwrap();owned.delete(part.entity);}
 function launch(kind:EquipmentProjectileKind,power=1){
  if(closed||parts.length>=REMOTE_RULES.maxActive)return false;
  const eye=b.physics.position(b.camera),pitch=b.pitch+(kind==='rpg'||kind==='charge'?0:8*Math.PI/180);
  const d:Vec3=[-Math.sin(b.yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(b.yaw)*Math.cos(pitch)];
  const p:Vec3=eye.map((n,i)=>n+d[i]*(kind==='rpg'?.65:.95)+(i===1?-.2:0)) as Vec3;
  // Do not spawn on the far side of a thin wall.
  const offset=p.map((n,i)=>n-eye[i]) as Vec3,offsetLength=Math.hypot(...offset),offsetDir=offset.map(n=>n/offsetLength) as Vec3;
  const wall=b.map.raycast(eye,offsetDir,offsetLength);if(wall)for(let i=0;i<3;i++)p[i]=eye[i]+offsetDir[i]*Math.max(0,wall.distance-.18);
  const min=kind==='molotov'?.63:.69,speed=kind==='rpg'?RPG_RULES.projectileSpeed:kind==='charge'?(b.mode==='conquest'?20:22):(kind==='molotov'?17.9:20.5)*(min+(1-min)*Math.min(1,Math.max(0,power)));
  const velocity=d.map((v,i)=>v*speed+(i===1&&kind==='charge'?.9:0)) as Vec3;
  const entity=world.spawn({component:Transform,data:{pos:p,quat:[0,Math.sin(b.yaw/2),0,Math.cos(b.yaw/2)]}},{component:RigidBody,data:{type:RigidBodyTypeValue.dynamic,ccdEnabled:true,gravityScale:(kind==='rpg'?RPG_RULES.gravity:16)/9.81,linearDamping:kind==='rpg'?0:.02,angularDamping:.2}},{component:MeshFilter,data:{assetHandle:handle(kind)}},{component:MeshRenderer,data:{materials:[]}}).unwrap();
  owned.add(entity);parts.push({entity,kind,previous:p,velocity,life:fuse[kind],age:0,admitted:false,landed:false,hp:REMOTE_RULES.health,bounceAt:-Infinity});if(kind==='rpg')lastRocket={phase:'flight',position:[...p],age:0};return true;
 }
 function stick(part:EquipmentProjectile,p:Vec3,actor?:AttachmentActor,normal:Vec3=[0,1,0],support?:Vec3){
  world.despawn(part.entity).unwrap();owned.delete(part.entity);
  part.entity=world.spawn({component:Transform,data:{pos:p,quat:surfaceQuat(normal)}},{component:MeshFilter,data:{assetHandle:handle(part.kind)}},{component:MeshRenderer,data:{materials:[]}}).unwrap();
  owned.add(part.entity);part.previous=p;part.landed=true;part.admitted=true;part.life=fuse[part.kind];part.normal=normal;part.support=support;
  if(actor){const q=b.physics.position(actor.entity);part.attachment={actor,offset:rotateYaw(p.map((n,i)=>n-q[i]) as Vec3,-(actor.yaw||0)),normal:rotateYaw(normal,-(actor.yaw||0))};}
  b.audio?.play('throwable.semtex.stick',p);
 }
 function detach(part:EquipmentProjectile){
  const p=b.physics.position(part.entity);world.despawn(part.entity).unwrap();owned.delete(part.entity);
  part.entity=world.spawn({component:Transform,data:{pos:p}},{component:RigidBody,data:{type:RigidBodyTypeValue.dynamic,ccdEnabled:true,gravityScale:16/9.81,linearDamping:.02}},{component:MeshFilter,data:{assetHandle:handle(part.kind)}},{component:MeshRenderer,data:{materials:[]}}).unwrap();
  owned.add(part.entity);part.previous=p;part.velocity=[0,0,0];part.admitted=false;part.landed=false;part.attachment=undefined;part.support=undefined;
 }
 function follow(part:EquipmentProjectile){const a=part.attachment;if(!a)return;if(a.actor.alive===false||(a.actor.hp!==undefined&&a.actor.hp<=0)){detach(part);return;}const q=b.physics.position(a.actor.entity),offset=rotateYaw(a.offset,a.actor.yaw||0);world.set(part.entity,Transform,{pos:q.map((n,i)=>n+offset[i]) as Vec3,quat:surfaceQuat(rotateYaw(a.normal,a.actor.yaw||0))}).unwrap();}
 const blasts:{kind:EquipmentProjectileKind;p:Vec3}[]=[];let draining=false;
 function explodeAll(selected:EquipmentProjectile[]){
  // Remove every selected device before any damage callback (death/chain reaction).
  let count=0;for(const part of selected){if(!parts.includes(part))continue;follow(part);blasts.push({kind:part.kind,p:b.physics.position(part.entity)});remove(part);count++;}
  if(!draining){draining=true;try{while(blasts.length){const next=blasts.shift()!;onEffect(next.kind,next.p);}}finally{draining=false;}}
  return count;
 }
 function explode(part:EquipmentProjectile){explodeAll([part]);}
 function update(dt:number){
  if(closed)return;
  for(const part of [...parts]){
   if(!parts.includes(part))continue;
   follow(part);if(part.support&&!b.map.solid(...part.support))detach(part);
   if(!part.landed)b.physics.around(b.physics.position(part.entity));
   if(!part.admitted){
    if(!b.physics.backend.hasBody(part.entity))continue;
    const result=b.physics.backend.prepareDerivedShapeCandidate!({entity:part.entity,sourceKey:'equipment-projectile/'+part.entity,revision:1,bodyType:'dynamic',shapes:[{id:'body',revision:1,cells:[[0,0,0]],voxelSize:[.18,.2,.18],origin:part.kind==='rpg'?[-.09,-.1,-.09]:[0,0,0],isSensor:part.kind==='rpg'||part.kind==='charge'||part.kind==='semtex'||part.kind==='molotov',restitution:part.kind==='smoke'?.35:.5,friction:.8,collisionGroups:0x00110001}],motion:{centerOfMass:part.previous,linearVelocity:part.velocity,angularVelocity:part.kind==='rpg'?[0,0,0]:[3,2,1]}});
    if(!result.ok){if(result.error.code==='derived-candidate-budget-exceeded')continue;throw result.error;}
    const admitted=b.physics.backend.admitDerivedShapeCandidate!(result.value);if(!admitted.ok)throw admitted.error;part.admitted=true;continue;
   }
   part.age+=dt;
   const p=b.physics.position(part.entity),delta=p.map((n,i)=>n-part.previous[i]) as Vec3,len=Math.hypot(...delta),dir=delta.map(n=>n/(len||1)) as Vec3;
   const wall=!part.landed&&len>1e-6?b.map.raycast(part.previous,dir,len+.12):null;
   let contact:Vec3|null=wall?wall.point.map((n,i)=>n+wall.normal[i]*.16) as Vec3:null;
   let rocketImpact:RocketImpact|undefined=wall?{kind:'world'}:undefined;
   if(part.kind==='rpg'){
    lastRocket={phase:'flight',position:[...p],age:part.age};
    // Life expiry removes the projectile without a synthetic mid-air explosion.
    if(part.age>=RPG_RULES.projectileLife){lastRocket={phase:'expired',position:[...p],age:part.age};remove(part);continue;}
    if(len>1e-6){
     const limit=Math.min(len,wall?.distance??Infinity),vehicle=b.vehicles?.raycast(part.previous,dir,limit),actor=b.arena?.raycast?.(part.previous,dir,limit);
     let nearest=wall?.distance??Infinity;
     if(vehicle&&vehicle.distance<nearest){nearest=vehicle.distance;rocketImpact={kind:'vehicle',vehicle:vehicle.vehicle};contact=part.previous.map((n,i)=>n+dir[i]*nearest) as Vec3;}
     if(actor&&actor.distance<nearest){nearest=actor.distance;rocketImpact={kind:'unit'};contact=part.previous.map((n,i)=>n+dir[i]*nearest) as Vec3;}
     // Orientation is presentation only. Rapier owns position and velocity.
     const yaw=Math.atan2(-dir[0],-dir[2]),pitch=Math.asin(Math.max(-1,Math.min(1,dir[1]))),sy=Math.sin(yaw/2),cy=Math.cos(yaw/2),sx=Math.sin(pitch/2),cx=Math.cos(pitch/2);
     world.set(part.entity,Transform,{quat:[cy*sx,sy*cx,-sy*sx,cy*cx]}).unwrap();
    }
   }
   let attachedActor:AttachmentActor|undefined,contactNormal=wall?.normal,nearest=Math.min(len+.12,wall?.distance??Infinity);
   if(!part.landed&&['charge','semtex','molotov'].includes(part.kind)&&len>0){

    for(const actor of b.arena?.units||[]){if(!actor.alive)continue;
     const q=b.arena!.position(actor),center:Vec3=[q[0],q[1]+.95,q[2]],v=center.map((n,i)=>n-part.previous[i]),t=v.reduce((sum,n,i)=>sum+n*dir[i],0),rr=.65*.65-v.reduce((sum,n)=>sum+n*n,0)+t*t;
     if(rr<0)continue;const hit=Math.max(0,t-Math.sqrt(rr));if(t+Math.sqrt(rr)<0||hit>nearest)continue;
     nearest=hit;contactNormal=dir.map(n=>-n) as Vec3;contact=part.previous.map((n,i)=>n+dir[i]*hit) as Vec3;attachedActor=actor;
    }
   }
    if(!part.landed&&len>0&&isRemoteExplosive(part.kind))for(const actor of b.vehicles?.vehicles||[]){if(actor.hp<=0)continue;const size=vehicleDefs[actor.type].size,hit=rayBox(part.previous,dir,b.physics.position(actor.entity),[size.x/2+.12,size.y/2+.12,size.z/2+.12],actor.yaw,nearest);if(!hit)continue;nearest=hit.distance;attachedActor=actor;contactNormal=hit.normal;contact=part.previous.map((n,i)=>n+dir[i]*hit.distance) as Vec3;}
   if(contact&&!part.landed){
    if(part.kind==='rpg'||part.kind==='molotov'){if(part.kind==='rpg'){if(rocketImpact?.kind==='world'&&wall)contact=wall.point;lastRocket={phase:'impact',position:[...contact],age:part.age,hit:rocketImpact?.kind};}remove(part);onEffect(part.kind,contact,rocketImpact);continue;}
    if(part.kind==='charge'||part.kind==='semtex'){stick(part,contact,attachedActor,contactNormal,attachedActor?undefined:wall?.cell);continue;}
    if(part.age-part.bounceAt>.085){b.audio?.play('throwable.'+part.kind+'.bounce',contact);part.bounceAt=part.age;}
    if(part.kind==='smoke'){part.landed=true;part.life=THROWABLE_RULES.smoke.fuse;}
   }
   // A bounce can be fully resolved inside a fixed physics step. Detect a
   // resting smoke grenade through the native ground query as well.
   if(part.kind==='smoke'&&!part.landed&&part.age>.2&&b.map.raycast(p,[0,-1,0],.25)){part.landed=true;part.life=1;}
   if(!isRemoteExplosive(part.kind)&&(part.kind!=='smoke'||part.landed))part.life-=dt;
   if(part.life<=0){if(part.kind==='charge'||part.kind==='rpg')remove(part);else explode(part);continue;}
   if(isRemoteExplosive(part.kind)){if(p[1]<-20||p[0]<-30||p[2]<-30||p[0]>b.map.width+30||p[2]>b.map.width+30){remove(part);continue;}}
   else if(part.kind!=='rpg'&&!part.landed&&part.age>4.5){if(part.kind==='smoke'){part.landed=true;part.life=.05;}else explode(part);continue;}
   part.previous=p;
  }
 }
 function detonateCharges(){return explodeAll(parts.filter(p=>isRemoteExplosive(p.kind)));}
 function clearCharges(){for(const p of [...parts])if(isRemoteExplosive(p.kind))remove(p);}
 function damageCharge(part:EquipmentProjectile,amount:number){if(!parts.includes(part)||!isRemoteExplosive(part.kind)||amount<=0)return;part.hp-=amount;if(part.hp<=0)explode(part);}
 function raycast(origin:Vec3,dir:Vec3,range:number){let nearest=range,selected:EquipmentProjectile|undefined;for(const part of parts){if(!isRemoteExplosive(part.kind))continue;follow(part);const p=b.physics.position(part.entity),delta=p.map((n,i)=>n-origin[i]),t=delta.reduce((sum,n,i)=>sum+n*dir[i],0),rr=.28**2-delta.reduce((sum,n)=>sum+n*n,0)+t*t;if(rr<0||t+Math.sqrt(rr)<0)continue;const hit=Math.max(0,t-Math.sqrt(rr));if(hit<=nearest){nearest=hit;selected=part;}}return selected?{part:selected,distance:nearest}:null;}
 function damageArea(p:Vec3,radius:number,amount:number){const selected:EquipmentProjectile[]=[];for(const part of parts){if(!isRemoteExplosive(part.kind))continue;const q=b.physics.position(part.entity),delta=q.map((n,i)=>n-p[i]) as Vec3,d=Math.hypot(...delta);if(d>radius||b.map.raycast(p,delta,Math.max(0,d-.3)))continue;part.hp-=amount*Math.max(.1,1-d/radius);if(part.hp<=0)selected.push(part);}explodeAll(selected);}
 return {launch,update,parts,get lastRocket(){return lastRocket;},detonateCharges,clearCharges,damageCharge,raycast,damageArea,get charges(){return parts.filter(p=>isRemoteExplosive(p.kind));},dispose(){if(closed)return;closed=true;for(const p of [...parts])remove(p);blasts.length=0;world.sharedRefs.release(mesh).unwrap();world.sharedRefs.release(rocketMesh).unwrap();}};
}
