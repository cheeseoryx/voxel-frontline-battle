import type {BattleState} from './battle.plugin.ts';
import type {Vec3} from './voxel-map.ts';
import {fireInterval,pelletDirections,shotSpread} from './weapon-shot-rules.ts';
export type GunshotRecord={sequence:number;weaponId:string;ads:boolean;spread:number;origin:Vec3;rays:{direction:Vec3;distance:number;target:string}[]};
/** One cartridge and one audio/cadence event per trigger; each pellet resolves independently. */
export function fireGun(b:BattleState,random=Math.random){
 if(!b.firing||b.dead||!b.gear?.canFireGun||b.vehicles?.seated||b.interacting||b.arena&&!b.arena.match.scoringLive()||b.cooldown>0||b.reload>0||b.mag<=0)return false;
 const def=b.weapon,weaponId=b.weaponId;
 const origin=b.physics.position(b.camera),base:Vec3=[-Math.sin(b.yaw)*Math.cos(b.pitch),Math.sin(b.pitch),-Math.cos(b.yaw)*Math.cos(b.pitch)];
 const directions=pelletDirections(base,def,b.mode,b.ads?1:0,random);if(!directions.length)return false;
 b.mag--;b.shots++;b.cooldown=fireInterval(def);if(!def.automatic)b.firing=false;
 b.skills?.breakStealth();b.audio?.gun(weaponId);b.spawnProtection=0;
 const record:GunshotRecord={sequence:b.shots,weaponId,ads:b.ads,spread:shotSpread(def,b.mode,b.ads?1:0),origin,rays:[]};
 for(const direction of directions){
  const range=def.range||150,wall=b.map.raycast(origin,direction,range),limit=wall?.distance??range;
  const device=b.gear.projectile.raycast(origin,direction,limit),vehicle=b.vehicles?.raycast(origin,direction,limit),unit=b.arena?.raycast(origin,direction,limit);
  // Queries never apply damage. Resolve the nearest surface across all owners first.
  let distance=limit,target=wall?'world':'miss',apply=()=>{if(wall&&b.map.breakBlock(...wall.cell))b.broken++;};
  if(device&&device.distance<distance){distance=device.distance;target='device';apply=()=>b.gear!.projectile.damageCharge(device.part,def.damage);}
  if(vehicle&&vehicle.distance<distance){distance=vehicle.distance;target='vehicle';apply=()=>b.vehicles!.damage(vehicle.vehicle,def.damage,'ally');}
  if(unit&&unit.distance<distance){distance=unit.distance;target=unit.kind;apply=()=>unit.apply(def.damage,weaponId);}
  apply();record.rays.push({direction,distance,target});
 }
 b.lastGunshot=record;return true;
}
