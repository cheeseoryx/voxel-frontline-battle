import type {Vec3} from './voxel-map.ts';
export type ThrowableKind='frag'|'semtex'|'molotov'|'flash'|'stun'|'smoke';
/** Numeric gameplay contract transcribed from both original throwables.js owners. */
export const THROWABLE_RULES={
 frag:{fuse:3,from:'throw',radius:6,inner:2.5,damage:130,edge:20,core:60,breakChance:.6},
 semtex:{fuse:0,from:'remote',radius:5.5,inner:2.2,damage:130,edge:20,core:70,breakChance:.6},
 molotov:{fuse:0,from:'impact',radius:3,duration:7,tick:.5,damage:25,core:10},
 flash:{fuse:1.5,from:'throw',radius:8,duration:3},
 stun:{fuse:1.5,from:'throw',radius:6,duration:7,move:.4,turn:.28,aiMove:.5},
 smoke:{fuse:1,from:'land',radius:5,height:3.4,expand:1.5,stable:12,fade:2}
} as const;
export const distance=(a:Vec3,b:Vec3)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
export const lift=(p:Vec3,y:number):Vec3=>[p[0],p[1]+y,p[2]];
export function blastDamage(kind:'frag'|'semtex',d:number){const r=THROWABLE_RULES[kind];return d>r.radius?0:Math.round(r.damage+(r.edge-r.damage)*Math.max(0,(d-r.inner)/(r.radius-r.inner)));}
export function flashDuration(d:number,dot:number){const r=THROWABLE_RULES.flash;if(d>r.radius)return 0;const deg=Math.acos(Math.max(-1,Math.min(1,dot)))*180/Math.PI;const facing=deg<40?1:deg<100?.55+.45*(1-(deg-40)/60):.55;return Math.max(.35,Math.min(r.duration,r.duration*facing*(.4+.6*(1-d/r.radius))));}
export function stunDuration(d:number){const r=THROWABLE_RULES.stun;return d>r.radius?0:Math.max(2.8,r.duration*(.55+.45*(1-d/r.radius)));}
export function smokeState(age:number){
 const r=THROWABLE_RULES.smoke,total=r.expand+r.stable+r.fade;
 const phase=age<r.expand?'expand':age<r.expand+r.stable?'stable':'fade';
 const progress=Math.max(0,Math.min(1,phase==='expand'?age/r.expand:phase==='fade'?(total-age)/r.fade:1));
 return {phase,radius:r.radius*progress,density:age>=total?0:phase==='expand'?.35+.65*progress:phase==='fade'?progress:1,life:Math.max(0,total-age)};
}
export function smokeOccludes(position:Vec3,age:number,a:Vec3,b:Vec3){
 const s=smokeState(age);if(s.density<.12||s.radius<.35)return false;
 let inside=0;for(let i=0;i<=12;i++){const t=i/12,y=a[1]+(b[1]-a[1])*t;
  if(y<position[1]-.2||y>position[1]-.2+THROWABLE_RULES.smoke.height)continue;
  const x=a[0]+(b[0]-a[0])*t-position[0],z=a[2]+(b[2]-a[2])*t-position[2];
  if(x*x+z*z<=s.radius*s.radius)inside++;
 }
 return inside>=(s.density>=.85?1:s.density>=.45?2:3);
}
export function aiThrowableStatus(now:number,blindUntil=0,stunUntil=0){return {canShoot:blindUntil-now<=.25&&stunUntil-now<=.2,move:stunUntil>now?THROWABLE_RULES.stun.aiMove:1};}
