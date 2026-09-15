import {Transform} from '@forgeax/engine/scene';
import {createBoxGeometry} from '@forgeax/engine/geometry';
import {weaponsFor,type ModeId} from '../catalog.ts';
import {createNativeArena} from '../native-arena.ts';
import {setup} from './equipment-fixture.ts';
const kit={primary:'sg',secondary:'usp',gadget1:'rpg',gadget2:'ammo',grenade:'frag',melee:'knife'};
async function arenaFixture(mode:ModeId='tdm'){
 const s=await setup(kit,mode),{b,world,physics}=s;Object.assign(b,{bonusShot:0,spawnProtection:0,spawn:[30,1.04,30],notice:()=>{},respawn:()=>{},leave:()=>{},setWeapon:(id:string)=>{b.weaponId=id;b.weapon=weaponsFor(mode)[id];}});
 const host:any={assets:{loadByGuid:async()=>({ok:true,value:createBoxGeometry(.5,1.8,.5).unwrap()})}};
 const arena=await createNativeArena(world,host,mode,{seed:44,bases:[{x:20,y:1.04,z:20},{x:45,y:1.04,z:45}]},b,physics,()=>false);b.arena=arena;arena.match.phase='battle';
 for(const u of arena.units)u.alive=false;const target=arena.units.find(u=>u.team==='enemy')!;target.alive=true;target.protection=0;target.hp=1000;physics.teleport(target.entity,[30,1.94,22]);physics.teleport(b.playerBody,[30,1.94,30]);world.set(b.camera,Transform,{pos:[30,2.1,30]}).unwrap();b.ads=false;b.firing=true;
 return {...s,arena,target,host,dispose(){b.vehicles?.dispose();arena.dispose();s.dispose();}};
}
export {arenaFixture};
