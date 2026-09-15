import type {Weapon,ModeId} from './catalog.ts';
import type {Vec3} from './voxel-map.ts';
/** Imported large-war rates are RPM, except the original <=5 second legacy entries. */
export function fireInterval(def:Weapon){const rate=Number(def.fireRate);return rate>0?(rate<=5?rate:60/rate):.1;}
export function shotSpread(def:Weapon,mode:ModeId,ads=0,sliding=false){
 const explicit=typeof def.spread==='number',accuracy=Math.max(0,Math.min(100,Number(def.accuracy??70)));
 const hip=explicit?Number(def.spread):mode==='conquest'?.12*(1-accuracy/100):0;
 const mul=def.scope==='sniper'?.03:def.scope==='optic'?.31:.6;
 const aimed=typeof def.adsSpread==='number'?def.adsSpread:mode==='conquest'?hip*mul:hip;
 if(sliding&&mode==='conquest')return hip*1.35;
 return mode==='conquest'?(ads<=0?hip:ads>=1?aimed:hip+(aimed-hip)*ads):hip+(aimed-hip)*Math.max(0,Math.min(1,ads));
}
/** The original samples each XYZ component independently, then normalizes. */
export function pelletDirections(base:Vec3,def:Weapon,mode:ModeId,ads=0,random=Math.random,sliding=false){
 const spread=shotSpread(def,mode,ads,sliding),count=Math.max(0,Math.floor(Number(def.pellets??1)));
 return Array.from({length:count},()=>{const dir=base.map(n=>n+(spread>0?(random()-.5)*spread*2:0)) as Vec3;if(spread<=0)return dir;const length=Math.hypot(...dir)||1;return dir.map(n=>n/length) as Vec3;});
}
