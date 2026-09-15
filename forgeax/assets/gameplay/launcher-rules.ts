import {vehicleWeapons} from '../original/vehicle-rules.ts';
export const RPG_RULES={...vehicleWeapons.rpg,blastRadius:3.2,breakRadius:1.45};
/** Old anti-armor splash is 40% of direct damage, with a 12 point minimum. */
export function rpgInfantryDamage(distance:number){return distance>RPG_RULES.blastRadius?0:Math.max(12,Math.min(110,RPG_RULES.damage*.4)*(1-distance/RPG_RULES.blastRadius));}
