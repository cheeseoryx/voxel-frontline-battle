import type {BattleState} from './battle.plugin.ts';
import type {Vec3} from './voxel-map.ts';
import {smooth,quatXYZ} from './melee-rules.ts';
export const INSPECT_DURATION=2.4;
const HIP:Vec3=[.3,-.34,-.52];
export function inspectPose(t:number,melee:boolean,startFov=70){
 const e=smooth(t/.42),he=smooth((t-.28)/1.55),target:Vec3=[.12,melee?-.2:-.22,melee?-.5:-.56],pos=HIP.map((n,i)=>n+(target[i]-n)*e+(i===0?Math.sin(t*1.55)*.007:i===1?Math.cos(t*1.12)*.005:0)) as Vec3;
 const quat=quatXYZ(.14*e+.08*he,(melee?1.05:.92)*he+Math.sin(t*.7)*.024,.08*e);
 // Existing gun/arm vertices already contain HIP. Rotate them about that pivot.
 const [x,y,z,w]=quat,[vx,vy,vz]=HIP,tx=2*(y*vz-z*vy),ty=2*(z*vx-x*vz),tz=2*(x*vy-y*vx);
 const rotated=[vx+w*tx+y*tz-z*ty,vy+w*ty+z*tx-x*tz,vz+w*tz+x*ty-y*tx];
 return {pos,quat,gunRigPos:pos.map((n,i)=>n-rotated[i]) as Vec3,left:{rx:-.22*he,rz:.18*he,y:-.02*he,z:.03*he},pitch:-.04*e-.02*he,yaw:.06*he,roll:.025*e,fov:startFov+((melee?64:62)-startFov)*e};
}
export type InspectPose=ReturnType<typeof inspectPose>;
/** Original small-mode finale. No inspect key, no click-to-skip, no mid-round trigger. */
export function createMatchInspect(b:BattleState,present:(pose:InspectPose,melee:boolean)=>void,restore:()=>void,startFov:()=>number){
 let state:'idle'|'playing'|'complete'|'disposed'='idle',elapsed=0,melee=false,weapon='',fov=70;
 const pending=()=>state==='idle'&&b.mode!=='conquest'&&!!b.arena?.match.ended;
 function update(dt:number){
  if(state==='disposed')return false;
  if(pending()){state='playing';melee=b.gear?.inventory.slot==='melee';weapon=b.weaponId;fov=startFov();b.gear?.prepareInspect();b.building?.cancel();b.keys.clear();b.ads=b.firing=false;b.reload=0;present(inspectPose(0,melee,fov),melee);}
  if(state!=='playing')return false;
  b.keys.clear();b.firing=b.ads=false;b.reload=0;elapsed=Math.min(INSPECT_DURATION,elapsed+Math.max(0,dt));present(inspectPose(elapsed,melee,fov),melee);
  if(elapsed+1e-8>=INSPECT_DURATION){elapsed=INSPECT_DURATION;state='complete';restore();}return true;
 }
 return {update,get active(){return state==='playing';},get blocksSimulation(){return pending()||state==='playing';},get blocksInput(){return !!b.arena?.match.ended;},get resultsReady(){return !!b.arena?.match.ended&&!pending()&&state!=='playing';},snapshot:()=>({state,elapsed,duration:INSPECT_DURATION,weapon,melee}),dispose(){if(state==='disposed')return;if(state==='playing')restore();state='disposed';}};
}
