import {vec3} from '@forgeax/engine/math';
import {FixedTime,type World,type EntityHandle} from '@forgeax/engine/ecs';
import {Transform,Name} from '@forgeax/engine/scene';
import {RigidBody,RigidBodyTypeValue,Collider,ColliderShapeValue,CharacterController,type PhysicsWorld} from '@forgeax/engine/physics';
import type {VoxelMap,Vec3} from './voxel-map.ts';
/** A battle owns streamed terrain bodies. The Engine owns all collision response. */
export class NativePhysics {
 readonly backend:PhysicsWorld;
 readonly chunks=new Map<string,{entity:EntityHandle;revision:number}>();
 private wanted=new Set<string>();private teleported=new Map<EntityHandle,number>();
 constructor(readonly world:World,readonly map:VoxelMap){this.backend=world.getResource<PhysicsWorld>('PhysicsWorld');if(!this.backend?.prepareDerivedShapeCandidate||!this.backend.admitDerivedShapeCandidate)throw Error('造化 Rapier 3D 体素碰撞能力未就绪');}
 around(p:Vec3,radius=1){const cx=Math.floor(p[0]/16),cz=Math.floor(p[2]/16);for(let x=cx-radius;x<=cx+radius;x++)for(let z=cz-radius;z<=cz+radius;z++)if(x>=0&&z>=0&&x*16<this.map.width&&z*16<this.map.width)this.wanted.add(x+','+z);}
 flush(){const until=performance.now()+7;for(const key of this.wanted){let chunk=this.chunks.get(key);if(!chunk){const [x,z]=key.split(',').map(Number);const entity=this.world.spawn({component:Transform,data:{pos:[x*16,0,z*16]}},{component:Name,data:{value:'碰撞地形 '+key}},{component:RigidBody,data:{type:RigidBodyTypeValue.static}}).unwrap();chunk={entity,revision:-1};this.chunks.set(key,chunk);}
   if(!this.backend.hasBody(chunk.entity))continue;const revision=this.map.revisions.get(key)||0;if(chunk.revision===revision)continue;
   const [cx,cz]=key.split(',').map(Number),cells:number[]=[];for(let x=0;x<16;x++)for(let z=0;z<16;z++)for(let y=0;y<this.map.height;y++)if(this.map.solid(cx*16+x,y,cz*16+z))cells.push(x,y,z);
   const candidate=this.backend.prepareDerivedShapeCandidate!({entity:chunk.entity,sourceKey:'terrain/'+key,revision:revision+1,bodyType:'static',shapes:cells.length?[{id:'voxels',revision:revision+1,cells:new Int32Array(cells),voxelSize:[1,1,1],origin:[0,0,0],collisionGroups:0x0001ffff}]:[]});if(!candidate.ok)throw candidate.error;const admitted=this.backend.admitDerivedShapeCandidate!(candidate.value);if(!admitted.ok)throw admitted.error;chunk.revision=revision;if(performance.now()>until)break;
  }
  for(const [key,c] of this.chunks)if(!this.wanted.has(key)){this.world.despawn(c.entity).unwrap();this.chunks.delete(key);}this.wanted.clear();
 }
 ready(p:Vec3){const key=Math.floor(p[0]/16)+','+Math.floor(p[2]/16),c=this.chunks.get(key);return !!c&&!!this.backend.getDerivedPublication?.(c.entity);}
 character(feet:Vec3,name:string,group=2,half:Vec3=[.32,.9,.32]){return this.world.spawn({component:Name,data:{value:name}},{component:Transform,data:{pos:[feet[0],feet[1]+half[1]+.04,feet[2]]}},{component:RigidBody,data:{type:RigidBodyTypeValue.kinematic}},{component:Collider,data:{shape:group===8?ColliderShapeValue.cuboid:ColliderShapeValue.capsule,halfExtents:half,radius:half[0],halfHeight:half[1]-half[0],collisionGroups:(group<<16)|(group===4?9:group===2?13:7)}},{component:CharacterController,data:{autoStepMaxHeight:group===8?1.1:1.05,autoStepMinWidth:.15,snapToGroundDist:.3}}).unwrap();}
 position(entity:EntityHandle){return Array.from(this.world.get(entity,Transform).unwrap().pos) as Vec3;}
 teleport(entity:EntityHandle,center:Vec3){this.teleported.set(entity,this.world.getResource(FixedTime).tick);this.world.set(entity,Transform,{pos:center}).unwrap();if(this.backend.hasBody(entity))this.backend.teleport(entity,vec3.create(...center));this.around(center);}
 move(entity:EntityHandle,delta:Vec3){const p=this.position(entity);this.around(p);const teleportTick=this.teleported.get(entity);if(teleportTick!==undefined){if(this.world.getResource(FixedTime).tick<=teleportTick)return [0,0,0] as Vec3;this.teleported.delete(entity);}if(!this.backend.hasBody(entity)||!this.ready(p))return [0,0,0] as Vec3;return Array.from(this.backend.moveAndSlide(entity,vec3.create(...delta))) as Vec3;}
 grounded(entity:EntityHandle){return this.world.get(entity,CharacterController).unwrap().grounded===true;}
 dispose(){for(const c of this.chunks.values())this.world.despawn(c.entity).unwrap();this.chunks.clear();this.wanted.clear();this.teleported.clear();}
}
