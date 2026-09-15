import type {Vec3} from './voxel-map.ts';
import type {ModeId} from './catalog.ts';
export type MeleePhase='idle'|'windup'|'active'|'recovery';
export type Pose={x:number;y:number;z:number;rx:number;ry:number;rz:number};
export const smooth=(t:number)=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
export function quatXYZ(x:number,y:number,z:number):[number,number,number,number]{const sx=Math.sin(x/2),sy=Math.sin(y/2),sz=Math.sin(z/2),cx=Math.cos(x/2),cy=Math.cos(y/2),cz=Math.cos(z/2);return [sx*cy*cz+cx*sy*sz,cx*sy*cz-sx*cy*sz,cx*cy*sz+sx*sy*cz,cx*cy*cz-sx*sy*sz];}
export function backstab(attacker:Vec3,target:Vec3,yaw:number){const x=attacker[0]-target[0],z=attacker[2]-target[2],len=Math.hypot(x,z);return len>=.05&&(-Math.sin(yaw)*x-Math.cos(yaw)*z)/len<=-.5;}
export function slashPose(mode:ModeId,phase:MeleePhase,t:number,def:{windupTime:number;recoveryTime:number},rest:Pose):Pose{
 const cock=phase==='windup'?smooth(t/Math.max(.001,def.windupTime)):0,thrust=phase==='active'?smooth(t/.055):phase==='recovery'?1-smooth(t/Math.max(.001,def.recoveryTime)):0;
 return mode==='conquest'?{x:rest.x+.06*cock-.2*thrust,y:rest.y-.05*cock+.14*thrust,z:rest.z+.18*cock-.52*thrust,rx:rest.rx+.22*cock-.28*thrust,ry:rest.ry-.08*cock-.32*thrust,rz:rest.rz+.1*cock-.45*thrust}:{x:rest.x+.07*cock-.16*thrust,y:rest.y+.06*cock+.12*thrust,z:rest.z+.16*cock-.5*thrust,rx:rest.rx+.04*cock+.04*thrust,ry:rest.ry+.16*cock+.13*thrust,rz:rest.rz-.12*cock-.13*thrust};
}
