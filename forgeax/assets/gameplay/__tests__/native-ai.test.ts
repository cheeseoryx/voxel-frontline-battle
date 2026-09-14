import {smallTerrainMaterialGuid} from '../../identity.ts';
import {it,expect} from 'vitest';
import {World} from '@forgeax/engine/ecs';
import {Transform,GlobalTransform,Name,ChildOf} from '@forgeax/engine/scene';
import {MeshFilter,MeshRenderer,Visibility} from '@forgeax/engine/render';
import {registerPhysicsComponents} from '@forgeax/engine/physics';
import {createRapier3DPhysicsWorld,loadRapier3D,registerPhysicsSystems} from '@forgeax/engine/physics-rapier3d';
import {createBoxGeometry} from '@forgeax/engine/geometry';
import {NativePhysics} from '../native-physics.ts';
import {VoxelMap} from '../voxel-map.ts';
import {createNativeArena} from '../native-arena.ts';
it('new tactical AI moves with Rapier, produces scored combat and releases every owned entity',async()=>{
 const w=new World();for(const c of [Transform,GlobalTransform,Name,ChildOf,MeshFilter,MeshRenderer,Visibility])w.components.register(c).unwrap();registerPhysicsComponents(w);const rapier=await loadRapier3D();if('code' in rapier)throw Error(rapier.code);const backend=createRapier3DPhysicsWorld(rapier);w.insertResource('PhysicsWorld',backend);const unregister=registerPhysicsSystems(w),width=64,height=12,ground=new Int8Array(width*width);ground.fill(0);const m=new VoxelMap(width,height,new Uint8Array(width*width*height),ground,new Float32Array(width*width),{});for(let x=0;x<width;x++)for(let z=0;z<width;z++)m.set(x,0,z,1);
 const physics=new NativePhysics(w,m),playerBody=physics.character([30,1.04,16],'Player'),camera=w.spawn({component:Transform,data:{pos:[30,2.84,16]}}).unwrap();const combat:any={camera,playerBody,material:smallTerrainMaterialGuid,elapsed:0,health:100,armor:50,dead:false,spawnProtection:0,spawn:[30,1.04,16],map:m,weaponId:'ar',keys:new Set(),interacting:false,ammoState:{ar:{mag:30,reserve:100}},setWeapon(id:string){this.weaponId=id;},respawn(p:number[]){this.health=100;this.armor=50;this.dead=false;w.set(camera,Transform,{pos:[p[0],p[1]+1.8,p[2]]}).unwrap();},notice(){},leave(){}};
 const host:any={assets:{loadByGuid:async()=>({ok:true,value:createBoxGeometry(.6,1.8,.5).unwrap()})}};const arena=await createNativeArena(w,host,'tdm',{seed:44,bases:[{x:30,y:1.04,z:16},{x:30,y:1.04,z:48}],zones:[],sites:[]},combat,physics,()=>false);
 try{const original=arena.position(arena.units[0]);for(let i=0;i<1500;i++){combat.elapsed+=1/60;arena.update(1/60);physics.around(physics.position(playerBody));physics.flush();w.update(1/60).unwrap();}expect(arena.match.score.ally+arena.match.score.enemy).toBeGreaterThan(0);expect(arena.position(arena.units[0])).not.toEqual(original);expect(arena.units.every(u=>physics.position(u.entity)[1]>1)).toBe(true);arena.dispose();physics.dispose();w.despawn(playerBody).unwrap();w.despawn(camera).unwrap();w.update(1/60).unwrap();expect(backend.getBodyCount()).toBe(0);}finally{unregister();backend.dispose();}
},30000);
