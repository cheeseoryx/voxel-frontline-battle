import type {Vec3} from './voxel-map.ts';
export const isRemoteExplosive=(kind:string)=>kind==='charge'||kind==='semtex';
export const REMOTE_RULES={health:60,maxActive:32,skillCooldown:24,throwLock:.45} as const;
export function vanguardDamage(d:number){return d>7.5?0:Math.round(d<=3.5?120:d<=5.5?120-20*(d-3.5):80-10*(d-5.5));}
export function rotateYaw(p:Vec3,yaw:number):Vec3{const c=Math.cos(yaw),s=Math.sin(yaw);return [p[0]*c+p[2]*s,p[1],p[2]*c-p[0]*s];}
export function surfaceQuat(n:Vec3):[number,number,number,number]{const length=Math.hypot(...n)||1,x=n[0]/length,y=n[1]/length,z=n[2]/length;if(y<-.99999)return [1,0,0,0];const s=Math.sqrt(2*(1+y));return [z/s,0,-x/s,s/2];}
/** Ray in a yaw-oriented box; query only, the Engine remains the physics owner. */
export function rayBox(origin:Vec3,dir:Vec3,center:Vec3,half:Vec3,yaw:number,range:number){
 const p=rotateYaw(origin.map((v,i)=>v-center[i]) as Vec3,-yaw),d=rotateYaw(dir,-yaw);let lo=0,hi=range,normal:Vec3=[0,1,0];
 for(let i=0;i<3;i++){if(Math.abs(d[i])<1e-8){if(Math.abs(p[i])>half[i])return null;continue;}const a=(-half[i]-p[i])/d[i],z=(half[i]-p[i])/d[i],near=Math.min(a,z);if(near>lo){lo=near;normal=[0,0,0];normal[i]=a<z?-1:1;}hi=Math.min(hi,Math.max(a,z));if(lo>hi)return null;}
 return {distance:lo,normal:rotateYaw(normal,yaw)};
}
