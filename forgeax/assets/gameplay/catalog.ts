import original from '../original/rules.ts';
import {createEconomy as largeEconomy} from '../original/large-economy.ts';
import {createEconomy as smallEconomy} from '../original/small-economy.ts';
export type Runtime='large'|'small';
export type ModeId='conquest'|'core'|'tdm'|'demo'|'ffa'|'gungame';
export type Slot='primary'|'secondary'|'gadget1'|'gadget2'|'grenade'|'melee';
export type Loadout=Record<Slot,string>;
export type Weapon={id:string;name:string;nameZh?:string;category?:string;damage:number;magSize:number;reserve:number;fireRate:number;reloadTime:number;range:number;[key:string]:unknown};
export type Item={id:string;name:string;kind:string;category?:string;desc:string;weapon?:boolean;def?:Weapon};
export type SoldierClass={id:string;nameZh?:string;label:string;role:string;blurb:string;activeSkill?:{name:string;desc:string};passiveSkill?:{name:string;desc:string}};
export const MODE_NAMES:Record<ModeId,string>={conquest:'大型战争 · 征服',core:'核心攻防',tdm:'团队死斗',demo:'爆破模式',ffa:'自由混战',gungame:'枪械模式'};
export const SLOT_NAMES:Record<Slot,string>={primary:'主武器',secondary:'副武器',gadget1:'轻型装备',gadget2:'重型装备',grenade:'投掷物',melee:'近战'};
export const SLOT_IDS=Object.keys(SLOT_NAMES) as Slot[];
export const runtimeFor=(mode:ModeId):Runtime=>mode==='conquest'?'large':'small';
export const classesFor=(mode:ModeId)=>original[runtimeFor(mode)].classes as readonly SoldierClass[];
export const className=(c:SoldierClass)=>c.nameZh||c.label.split(/[|｜]/).pop()?.trim()||c.id;
export const weaponsFor=(mode:ModeId)=>original[runtimeFor(mode)].weapons as unknown as Record<string,Weapon>;
export const teamless=(mode:ModeId)=>mode==='ffa'||mode==='gungame';
export const paramsFor=(mode:ModeId):Record<string,unknown>=>mode==='conquest'?{teamSize:32,scoreLimit:1000,timeLimit:2700,building:true}:original.small.modes.find(m=>m.id===mode)!.params;
export type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export interface Economy {
 getCoins():number;getMeta():Record<string,unknown>;ownsWeapon(id:string):boolean;ownsThrowable?(id:string):boolean;
 buy(id:string,qty?:number):{ok:boolean;reason?:string};
 weaponForSlot?(slot:number):string;throwableForSlot?():string;
 setLoadoutSlot?(id:string,slot:number):Record<string,string>;setThrowableSlot?(id:string):Record<string,string>;
}
export function createEconomies(storage:StoragePort):Record<Runtime,Economy>{
 const make=(runtime:Runtime)=>{const data=original[runtime];const env={VF:{WEAPONS:data.weapons,WEAPON_CATALOG:data.weaponCatalog,WEAPON_LOADOUT_ORDER:data.loadoutOrder,THROWABLE_CATALOG:runtime==='small'?original.small.throwables:undefined,BLOCK:data.blocks}};
 return (runtime==='large'?largeEconomy:smallEconomy)(env,storage) as Economy;};
 return {large:make('large'),small:make('small')};
}
export function initialLoadout(runtime:Runtime,economy:Economy):Loadout{
 return {primary:runtime==='large'?'ak74':economy.weaponForSlot!(1),secondary:runtime==='large'?'usp':economy.weaponForSlot!(2),gadget1:'medkit',gadget2:'ammo',grenade:runtime==='large'?'frag':economy.throwableForSlot!(),melee:'knife'};
}
export function itemsFor(mode:ModeId,slot:Slot):Item[]{
 const runtime=runtimeFor(mode),data=original[runtime],weapons=weaponsFor(mode);
 if(slot==='primary'||slot==='secondary'){
  const ids=runtime==='large'?[...data.loadoutOrder]:['ar','sg','sr',...data.loadoutOrder];
  return [...new Set(ids)].filter(id=>weapons[id]&&(runtime==='small'||(slot==='primary'?weapons[id].category!=='pistol':weapons[id].category==='pistol'))).map(id=>{const w=weapons[id];return {id,name:w.nameZh||w.name,kind:w.category==='pistol'?'pistol':w.category==='shotgun'?'shotgun':'rifle',category:w.category,desc:String(w.caliber||''),weapon:true,def:w};});
 }
 if(runtime==='large'){
  const list=slot==='grenade'?original.large.gadgets.grenades:slot==='melee'?original.large.gadgets.melee:original.large.gadgets.equipment;
  return list.map(i=>({...i,def:weapons[i.id]}));
 }
 if(slot==='grenade')return Object.entries(original.small.throwables).map(([id,def])=>({id,name:def.nameZh,kind:id,desc:def.flavor||''}));
 if(slot==='melee')return [{id:'knife',name:'战术匕首',kind:'knife',desc:'近战'}];
 return [];
}
export function ownsItem(mode:ModeId,slot:Slot,item:Item,economy:Economy):boolean{
 if(item.weapon)return item.id==='rpg'||economy.ownsWeapon(item.id);
 return runtimeFor(mode)==='small'&&slot==='grenade'?!!economy.ownsThrowable?.(item.id):true;
}
export function equipItem(mode:ModeId,slot:Slot,id:string,loadout:Loadout,economy:Economy):boolean{
 if(mode==='gungame')return false;
 const item=itemsFor(mode,slot).find(i=>i.id===id);if(!item||!ownsItem(mode,slot,item,economy))return false;
 if(runtimeFor(mode)==='small'){
  if(slot==='primary'||slot==='secondary'){economy.setLoadoutSlot!(id,slot==='primary'?1:2);if(economy.weaponForSlot!(slot==='primary'?1:2)!==id)return false;}
  else if(slot==='grenade'){economy.setThrowableSlot!(id);if(economy.throwableForSlot!()!==id)return false;}
 }
 loadout[slot]=id;return true;
}
export {original};
