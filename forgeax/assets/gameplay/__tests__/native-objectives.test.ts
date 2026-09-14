import source from '../../original/core-map.ts';
import {inflateBase64} from '../voxel-map.ts';
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
const fullSquads=process.env.NATIVE_FULL_CORE==='1';
it(fullSquads?'full squads advance the core objective':'an attacking AI traverses the authored map, uses native links and destroys the defended core',async()=>{
 const w=new World();for(const c of [Transform,GlobalTransform,Name,ChildOf,MeshFilter,MeshRenderer,Visibility])w.components.register(c).unwrap();registerPhysicsComponents(w);const rapier=await loadRapier3D();if('code' in rapier)throw Error(rapier.code);const backend=createRapier3DPhysicsWorld(rapier);w.insertResource('PhysicsWorld',backend);const unregister=registerPhysicsSystems(w),width=source.width,height=source.height;const [blocks,groundBytes,terrainBytes]=await Promise.all([inflateBase64(source.blocksGzip,width*width*height),inflateBase64(source.groundGzip,width*width),inflateBase64(source.terrainGzip,width*width*4)]),m=new VoxelMap(width,height,blocks,new Int8Array(groundBytes.buffer as ArrayBuffer),new Float32Array(terrainBytes.buffer as ArrayBuffer),source.hits);
 const physics=new NativePhysics(w,m),playerBody=physics.character([30,1.04,16],'Player'),camera=w.spawn({component:Transform,data:{pos:[30,2.84,16]}}).unwrap();const combat:any={camera,playerBody,material:smallTerrainMaterialGuid,elapsed:0,health:100,armor:50,classId:'vanguard',stealthUntil:0,shieldUntil:0,shieldHealth:0,deployables:[],buildBlocks:8,buildCores:0,dead:false,spawnProtection:0,spawn:[30,1.04,16],map:m,weaponId:'ar',keys:new Set(),interacting:false,ammoState:{ar:{mag:30,reserve:100}},setWeapon(id:string){this.weaponId=id;},respawn(p:number[]){this.health=100;this.armor=50;this.dead=false;w.set(camera,Transform,{pos:[p[0],p[1]+1.8,p[2]]}).unwrap();},notice(){},leave(){}};
 const host:any={assets:{loadByGuid:async()=>({ok:true,value:createBoxGeometry(.6,1.8,.5).unwrap()})}};const arena=await createNativeArena(w,host,'core',source,combat,physics,()=>false);

 const tick=()=>{combat.elapsed+=1/60;arena.update(1/60);physics.around(physics.position(playerBody));physics.flush();w.update(1/60).unwrap();};
 try{
  expect(source.mapKit!.placed).toHaveLength(59);expect(source.buildings).toHaveLength(45);expect(arena.nav.links).toHaveLength(12);
  const attacker=arena.units.find(u=>u.id==='bot-26')!,home=physics.position(playerBody);if(!fullSquads)for(const u of arena.units){u.alive=false;u.hp=0;u.respawn=Infinity;}
  for(let i=0;i<320;i++)tick();
  if(!fullSquads)for(const link of arena.nav.links.filter((_,i)=>i%2===0)){
   physics.teleport(playerBody,[link.from[0],link.from[1]+.9,link.from[2]]);for(let i=0;i<15;i++)tick();expect(arena.useZipline()).toBe(true);
   for(let i=0;i<1000&&arena.traversingPlayer;i++)tick();expect(arena.traversingPlayer).toBe(false);expect(Math.hypot(...arena.position(arena.player).map((v,i)=>v-link.to[i]))).toBeLessThan(.8);
   expect(arena.useZipline()).toBe(true);for(let i=0;i<1000&&arena.traversingPlayer;i++)tick();expect(arena.traversingPlayer).toBe(false);expect(Math.hypot(...arena.position(arena.player).map((v,i)=>v-link.from[i]))).toBeLessThan(.8);
  }
  physics.teleport(playerBody,home);attacker.alive=true;attacker.hp=100;const original=arena.position(attacker);
  for(let i=0;i<(fullSquads?21600:12000)&&!arena.match.ended;i++){tick();if(fullSquads&&Math.min(arena.match.score.ally,arena.match.score.enemy)<1000)break;}
  console.log(JSON.stringify({scenario:fullSquads?'full 50 combatants':'single attacking AI; other squads disabled to isolate navigation and core combat',elapsed:combat.elapsed,scores:arena.match.score,attacker:arena.position(attacker),mission:attacker.mission,links:arena.nav.links.length}));
  if(fullSquads)expect(Math.min(arena.match.score.ally,arena.match.score.enemy)).toBeLessThan(1000);else{expect(arena.match.score.ally).toBe(0);expect(arena.match.winner).toBe('enemy');}expect(arena.position(attacker)).not.toEqual(original);
  arena.dispose();physics.dispose();w.despawn(playerBody).unwrap();w.despawn(camera).unwrap();w.update(1/60).unwrap();expect(backend.getBodyCount()).toBe(0);
 }finally{unregister();backend.dispose();}

},120000);
