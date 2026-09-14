import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import vm from 'node:vm';
import {createEconomies,classesFor,initialLoadout,itemsFor,equipItem,original} from '../catalog.ts';
import {VoxelMap} from '../voxel-map.ts';
function storage(){const data=new Map<string,string>();return {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,String(value));},removeItem:(key:string)=>{data.delete(key);}};}
describe('original rules remain authoritative',()=>{
 for(const runtime of ['large','small'] as const)it(runtime+' economy transactions match the original runtime',()=>{
  const data=original[runtime],source=fs.readFileSync(runtime==='large'?'../js/economy.js':'../modes/small-battle/js/economy.js','utf8');const native=createEconomies(storage())[runtime];
  const context:any={document:{readyState:'complete',getElementById:()=>null},localStorage:storage(),VF:{WEAPONS:data.weapons,WEAPON_CATALOG:data.weaponCatalog,WEAPON_LOADOUT_ORDER:data.loadoutOrder,THROWABLE_CATALOG:runtime==='small'?original.small.throwables:undefined,BLOCK:data.blocks}};context.window=context;context.globalThis=context;vm.createContext(context);vm.runInContext(source,context);const legacy=context.VF.Economy;
  expect(JSON.stringify(native.getMeta())).toBe(JSON.stringify(legacy.getMeta()));
  for(const id of Object.keys(data.economy.catalog)){expect(JSON.stringify(native.buy(id,1))).toBe(JSON.stringify(legacy.buy(id,1)));expect(JSON.stringify(native.getMeta())).toBe(JSON.stringify(legacy.getMeta()));}
  for(const id of Object.keys(data.weapons))expect(native.ownsWeapon(id),id).toBe(legacy.ownsWeapon(id));
 });
 it('keeps different class rosters and actual equipment restrictions',()=>{
  expect(classesFor('conquest').map(c=>c.id)).toEqual(['assault','engineer','support','recon']);
  expect(classesFor('tdm').map(c=>c.id)).toEqual(['vanguard','medic','ghost','juggernaut','raider','engineer']);
  const e=createEconomies(storage()),large=initialLoadout('large',e.large),small=initialLoadout('small',e.small);
  expect(itemsFor('conquest','primary').some(i=>i.id==='usp')).toBe(false);
  expect(itemsFor('conquest','secondary').map(i=>i.id)).toEqual(['usp']);
  expect(equipItem('conquest','primary','usp',large,e.large)).toBe(false);
  expect(equipItem('tdm','primary','m200',small,e.small)).toBe(false);
  expect(equipItem('gungame','primary','ar',small,e.small)).toBe(false);
  expect(equipItem('tdm','secondary','ar',small,e.small)).toBe(true);
  expect(e.small.weaponForSlot!(2)).toBe('ar');
 });
});
function map(){const width=32,height=8;const ground=new Int8Array(width*width);ground.fill(-1);return new VoxelMap(width,height,new Uint8Array(width*width*height),ground,new Float32Array(width*width),{4:3,6:5});}
describe('native voxel interactions',()=>{
 it('shooting opens collision and updates both chunks at their boundary',()=>{const w=map();w.set(15,2,10,4);w.dirty.clear();expect(w.breakBlock(15,2,10)).toBe(false);expect(w.breakBlock(15,2,10)).toBe(false);expect(w.overlaps([15.5,2,10.5])).toBe(true);expect(w.breakBlock(15,2,10)).toBe(true);expect(w.overlaps([15.5,2,10.5])).toBe(false);expect(w.dirty.has('0,0')).toBe(true);expect(w.dirty.has('1,0')).toBe(true);});
 it('preserves original bedrock and terrain protection even with forced destruction',()=>{const w=map();w.set(2,0,2,15);expect(w.set(2,0,2,0)).toBe(false);expect(w.breakBlock(2,0,2,true)).toBe(false);w.set(3,1,3,3);w.ground[3*32+3]=1;expect(w.breakBlock(3,1,3,true)).toBe(false);});
 it('ray traversal returns the closest voxel, a face normal and exact distance',()=>{const w=map();w.set(10,3,9,4);w.set(15,3,9,6);expect(w.raycast([5,3.5,9.5],[2,0,0],20)).toMatchObject({cell:[10,3,9],normal:[-1,0,0],distance:5,point:[10,3.5,9.5]});expect(w.raycast([16,3.5,9.5],[-1,0,0],20)?.cell).toEqual([15,3,9]);expect(w.raycast([5,3.5,9.5],[0,0,0],20)).toBeNull();expect(w.raycast([5,3.5,9.5],[1,0,0],4)).toBeNull();});
 it('glass and smoke retain the original nonblocking collision and can break below ground',()=>{const w=map();for(const type of [13,16,17]){w.set(4,2,4,type);w.ground[4*32+4]=3;expect(w.solid(4,2,4)).toBe(false);expect(w.overlaps([4.5,2,4.5])).toBe(false);expect(w.breakBlock(4,2,4,true)).toBe(true);}});
 it('a malformed map fails before entering the world',()=>{expect(()=>new VoxelMap(32,8,new Uint8Array(0),new Int8Array(1024),new Float32Array(1024),{})).toThrow('dimensions');});
});
