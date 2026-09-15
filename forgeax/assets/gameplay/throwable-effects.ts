import type {BattleState} from './battle.plugin.ts';
import type {Vec3} from './voxel-map.ts';
import {teamless} from './catalog.ts';
import {THROWABLE_RULES as R,blastDamage,flashDuration,stunDuration,smokeState,smokeOccludes,distance,lift,type ThrowableKind} from './throwable-rules.ts';
export type ThrowableZone={id:number;kind:'smoke'|'molotov';position:Vec3;age:number;life:number;tick:number};
export type ThrowableVisuals={spawn:(kind:ThrowableKind,p:Vec3,zone?:ThrowableZone)=>void;update:(dt:number)=>void;remove:(id:number)=>void;dispose:()=>void};
/** Gameplay owns zones and statuses. Native scene visuals project this state. */
export function createThrowableEffects(b:BattleState,visuals:ThrowableVisuals,random:()=>number=Math.random){
 const zones:ThrowableZone[]=[];let serial=0,flashUntil=0,stunUntil=0,stunMax=0,shake=0,closed=false;
 const los=(a:Vec3,p:Vec3)=>!b.map.raycast(a,p.map((n,i)=>n-a[i]) as Vec3,Math.max(0,distance(a,p)-.2));
 const actors=()=>b.arena?[b.arena.player,...b.arena.units].filter(u=>u.alive&&(u.isPlayer||u.team!=='ally'||teamless(b.mode))):[];
 const point=(u:ReturnType<typeof actors>[number],y:number)=>lift(b.arena!.position(u),y);
 const damage=(u:ReturnType<typeof actors>[number],n:number,kind:string,from:Vec3)=>b.arena!.damage(u,n,b.arena!.player,kind,false,from);
 const ground=(p:Vec3):Vec3=>{const hit=b.map.raycast(lift(p,.15),[0,-1,0],Math.max(16,p[1]+2));return [p[0],hit?hit.point[1]+.04:p[1],p[2]];};
 function core(p:Vec3,radius:number,amount:number){if(b.mode!=='core')return;for(const o of b.arena?.objectives||[]){const q=lift(o.position,1.5);if(o.owner!=='ally'&&distance(p,q)<=radius&&los(p,q))b.arena?.match.damageCore(o.owner,amount,'ally');}}
 function detonate(kind:ThrowableKind,p:Vec3){
  if(closed)return;
  if(kind==='smoke'||kind==='molotov'){
   if(kind==='molotov'&&[p,lift(p,.5)].some(q=>b.map.get(...q.map(Math.floor) as Vec3)===8)){b.notice='燃烧瓶入水熄灭';b.noticeLeft=3;b.audio?.play('throwable.molotov.detonate',p);return;}
   const pos=ground(p),zone:ThrowableZone={id:++serial,kind,position:pos,age:0,life:kind==='smoke'?15.5:R.molotov.duration,tick:0};
   zones.push(zone);visuals.spawn(kind,pos,zone);b.audio?.play(kind==='smoke'?'throwable.smoke.ignite':'throwable.molotov.detonate',pos);if(kind==='molotov')shake=Math.max(shake,.14);return;
  }
  visuals.spawn(kind,p);b.audio?.play('throwable.'+kind+'.detonate',p);
  if(kind==='flash'||kind==='stun'){
   for(const u of actors()){
    const eye=point(u,kind==='flash'?(u.isPlayer?1.5:1.4):(u.isPlayer?1.1:1)),origin=lift(p,.45);
    if(!los(origin,eye))continue;
    if(kind==='flash'){
     const delta=origin.map((v,i)=>v-eye[i]),d=Math.hypot(...delta),look=u.isPlayer?[-Math.sin(b.yaw)*Math.cos(b.pitch),Math.sin(b.pitch),-Math.cos(b.yaw)*Math.cos(b.pitch)]:[-Math.sin(u.yaw||0),0,-Math.cos(u.yaw||0)];
     const duration=flashDuration(d,delta.reduce((sum,v,i)=>sum+v*look[i],0)/(d||1));if(duration<=0)continue;
     if(u.isPlayer){flashUntil=Math.max(flashUntil,b.elapsed+duration);shake=Math.max(shake,.28);b.audio?.play('throwable.flash.ring');}else u.blindUntil=Math.max(u.blindUntil||0,b.elapsed+duration);
    }else{
     const duration=stunDuration(distance(lift(p,.4),eye));if(duration<=0)continue;
     if(u.isPlayer){stunUntil=Math.max(stunUntil,b.elapsed+duration);stunMax=stunUntil-b.elapsed;shake=Math.max(shake,.35);b.pitch=Math.min(1.45,b.pitch+.04);}else u.stunUntil=Math.max(u.stunUntil||0,b.elapsed+duration);
    }
   }return;
  }
  const def=R[kind];b.ordnance?.burst(p,20);shake=Math.max(shake,.22);
  // Original destruction probabilities use ordinary block durability, never force=true.
  const span=Math.ceil(def.radius),center=p.map(Math.floor);
  for(let x=-span;x<=span;x++)for(let y=-span;y<=span;y++)for(let z=-span;z<=span;z++)if(x*x+y*y+z*z<=def.radius**2&&random()<=def.breakChance&&b.map.breakBlock(center[0]+x,center[1]+y,center[2]+z))b.broken++;
  for(const u of actors()){const q=point(u,u.isPlayer?1.1:1),amount=blastDamage(kind,distance(p,q));if(amount>0&&los(p,q))damage(u,amount,kind,p);}
  b.gear?.damageArea(p,def.radius,def.damage);
  core(p,def.radius,def.core);b.vehicles?.damageArea(p,def.radius,def.damage,'ally');
 }
 function fireTick(z:ThrowableZone){
  for(const u of actors()){const q=point(u,.4);if(distance(z.position,q)<=R.molotov.radius&&los(lift(z.position,.4),q))damage(u,R.molotov.damage,'molotov',z.position);}
  core(z.position,R.molotov.radius,R.molotov.core);
 }
 function update(dt:number){
  if(closed)return;shake=Math.max(0,shake-dt*.8);
  for(let i=zones.length-1;i>=0;i--){const z=zones[i],step=Math.min(dt,z.life);z.age+=step;z.life=Math.max(0,z.life-step);
   if(z.kind==='molotov'){z.tick+=step;while(z.tick+1e-8>=R.molotov.tick){z.tick-=R.molotov.tick;fireTick(z);}}
   if(z.life<=1e-8){visuals.remove(z.id);zones.splice(i,1);}
  }visuals.update(dt);
 }
 const blocksLine=(a:Vec3,p:Vec3)=>zones.some(z=>z.kind==='smoke'&&smokeOccludes(z.position,z.age,a,p));
 function smokeOpacity(p:Vec3){let opacity=0;for(const z of zones){if(z.kind!=='smoke')continue;const s=smokeState(z.age),r=Math.hypot(p[0]-z.position[0],p[2]-z.position[2]);if(p[1]<z.position[1]-.2||p[1]>z.position[1]+3.2)continue;opacity=Math.max(opacity,Math.min(1,Math.max(0,(s.radius-r)/.7))*s.density*.96);}return opacity;}
 function clearPlayerStatus(){flashUntil=stunUntil=stunMax=shake=0;}
 return {zones,detonate,update,blocksLine,smokeOpacity,clearPlayerStatus,
  get flash(){return Math.max(0,Math.min(1,(flashUntil-b.elapsed)/.6));},get flashLeft(){return Math.max(0,flashUntil-b.elapsed);},
  get stunLeft(){return Math.max(0,stunUntil-b.elapsed);},
  get cameraShake(){return Math.max(shake,stunUntil>b.elapsed?.28*Math.max(.35,(stunUntil-b.elapsed)/(stunMax||1)):0);},
  dispose(){if(closed)return;closed=true;zones.length=0;clearPlayerStatus();visuals.dispose();}
 };
}
