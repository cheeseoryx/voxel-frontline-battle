import {weaponsFor, type Loadout, type ModeId, type Slot, type Weapon} from './catalog.ts';

/** Carry rules from js/gadgets.js and js/weapons.js. No rendering/physics state. */
export const EQUIPMENT_RULES = Object.freeze({crateLife:42,crateHealth:120,crateRadius:1,healDelay:1,healRate:30,ammoRate:36,rocketRate:.5,grenadeRefill:15,grenadeCap:3,chargeRefill:4,chargeCap:2});
export function equipmentSlot(mode:ModeId,code:string):Slot|null {
 if(mode==='gungame')return null;
 if(code==='Digit1')return 'primary';if(code==='Digit2')return 'secondary';
 if(mode==='conquest')return ({Digit3:'gadget1',Digit4:'gadget2',Digit5:'grenade',Digit6:'melee'} as Record<string,Slot>)[code]||null;
 return code==='Digit3'&&mode!=='core'?'melee':null;
}
export function carrySnapshot(mode:ModeId,kit:Loadout):Readonly<Loadout> {
 const copy={...kit};
 if(mode==='conquest'&&copy.gadget1===copy.gadget2)copy.gadget2=copy.gadget1==='ammo'?'medkit':'ammo';
 if(mode!=='conquest'){copy.gadget1='';copy.gadget2='';}
 return Object.freeze(copy);
}
export class EquipmentInventory {
 readonly loadout:Readonly<Loadout>;
 skill:'charge'|null=null;slot:Slot='primary'; grenades=0; charges=0; grenadeProgress=0; chargeProgress=0;
 private fractions:Record<string,number>={};
 constructor(readonly mode:ModeId,kit:Loadout){this.loadout=carrySnapshot(mode,kit);this.reset();}
 get id(){return this.skill||this.loadout[this.slot];}
 get gun(){return !this.skill&&(this.slot==='primary'||this.slot==='secondary'||this.id==='rpg');}
 get carriedWeapons(){return [...new Set([this.loadout.primary,this.loadout.secondary,...(this.mode==='conquest'&&[this.loadout.gadget1,this.loadout.gadget2].includes('rpg')?['rpg']:[])])];}
 reset(){this.skill=null;this.slot='primary';this.grenades=this.mode==='gungame'?0:this.mode==='conquest'?2:1;this.charges=this.mode==='conquest'?2:0;this.grenadeProgress=0;this.chargeProgress=0;this.fractions={};}
 refill(dt:number,ammo:Record<string,{mag:number;reserve:number}>,defs:Record<string,Weapon>=weaponsFor(this.mode)){
  if(this.mode!=='conquest')return;
  for(const id of this.carriedWeapons){const d=defs[id],s=ammo[id];if(!d||!s)continue;const cap=2*(d.magSize+d.reserve),missing=Math.max(0,cap-s.mag-s.reserve);if(!missing){this.fractions[id]=0;continue;}
   const t=(this.fractions[id]||0)+dt*(d.projectile||d.category==='launcher'?EQUIPMENT_RULES.rocketRate:EQUIPMENT_RULES.ammoRate),n=Math.min(missing,Math.floor(t+1e-9));this.fractions[id]=t-n;
   const intoMag=Math.min(d.magSize-s.mag,n);s.mag+=intoMag;s.reserve+=n-intoMag;
  }
  if(this.grenades<EQUIPMENT_RULES.grenadeCap){this.grenadeProgress+=dt;while(this.grenadeProgress+1e-9>=15&&this.grenades<3){this.grenadeProgress-=15;this.grenades++;}}else this.grenadeProgress=0;
  if(this.charges<EQUIPMENT_RULES.chargeCap){this.chargeProgress+=dt;while(this.chargeProgress+1e-9>=4&&this.charges<2){this.chargeProgress-=4;this.charges++;}}else this.chargeProgress=0;
 }
}
