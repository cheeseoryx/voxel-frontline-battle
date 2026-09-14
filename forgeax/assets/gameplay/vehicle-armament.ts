import {vehicleWeapons} from '../original/vehicle-rules.ts';
const definitions=vehicleWeapons as Record<string,any>;
/** Per-weapon magazines, reserves, reloads and heat; updated on the owning battle clock. */
export class VehicleArmament {
 readonly shots:Record<string,number>={};readonly ammo:Record<string,number>={};readonly reserve:Record<string,number>={};readonly heat:Record<string,number>={};readonly reloads:Record<string,number>={};
 private cooldown:Record<string,number>={};private lastFire:Record<string,number>={};private overheated=new Set<string>();private supply=0;
 constructor(readonly ids:readonly string[]){this.reset();}
 reset(){for(const id of this.ids){const d=definitions[id];this.shots[id]=0;this.ammo[id]=d.magSize??Infinity;this.reserve[id]=d.reserve??0;this.heat[id]=0;this.reloads[id]=0;this.cooldown[id]=0;this.lastFire[id]=-Infinity;}this.overheated.clear();this.supply=0;}
 reload(id:string){const d=definitions[id];if(!d?.reloadSec||this.reloads[id]>0||this.reserve[id]<1||this.ammo[id]>=d.magSize)return false;this.reloads[id]=d.reloadSec;return true;}
 fire(id:string,now:number){const d=definitions[id];if(!d||this.cooldown[id]>0||this.reloads[id]>0||this.overheated.has(id))return false;if(this.ammo[id]<1){this.reload(id);return false;}if(Number.isFinite(this.ammo[id]))this.ammo[id]--;this.cooldown[id]=d.cooldown||.2;this.lastFire[id]=now;this.shots[id]++;if(d.maxHeat){this.heat[id]=Math.min(d.maxHeat,this.heat[id]+d.heatBuildPerSec*this.cooldown[id]);if(this.heat[id]>=d.maxHeat)this.overheated.add(id);}return true;}
 update(dt:number,now:number,supplying=false){for(const id of this.ids){const d=definitions[id];this.cooldown[id]=Math.max(0,this.cooldown[id]-dt);if(this.reloads[id]>0){this.reloads[id]=Math.max(0,this.reloads[id]-dt);if(!this.reloads[id]){const count=Math.min(d.magSize-this.ammo[id],this.reserve[id]);this.ammo[id]+=count;this.reserve[id]-=count;}}if(d.maxHeat&&now-this.lastFire[id]>=d.heatIdleDelay){this.heat[id]=Math.max(0,this.heat[id]-d.heatCoolPerSec*dt);if(this.heat[id]<=d.maxHeat*.35)this.overheated.delete(id);}}
  this.supply=supplying?this.supply+dt:0;while(this.supply>=1){this.supply--;for(const id of this.ids){const d=definitions[id];if(d.magSize)this.ammo[id]=Math.min(d.magSize,this.ammo[id]+Math.max(1,Math.ceil(d.magSize*.05)));if(d.reserveMax)this.reserve[id]=Math.min(d.reserveMax,this.reserve[id]+Math.max(1,Math.ceil(d.reserveMax*.05)));}}
 }
 status(id:string){const d=definitions[id];return this.reloads[id]>0?'装填 '+this.reloads[id].toFixed(1)+' 秒':d.maxHeat?(this.overheated.has(id)?'过热冷却':'热量 '+Math.ceil(this.heat[id])+'%'):this.ammo[id]+' / '+this.reserve[id];}
}
