import type {BattleState} from './battle.plugin.ts';
import {teamless,weaponsFor} from './catalog.ts';
import type {Vec3} from './voxel-map.ts';
import {backstab,slashPose,type Pose,type MeleePhase} from './melee-rules.ts';
type Unit=NonNullable<BattleState['arena']>['units'][number];
export type MeleeHit={target:string;damage:number;backstab:boolean;killed:boolean;position:Vec3;at:number};
/** Knife owns its timing and targeting. All movement uses the existing Rapier KCC. */
export function createMelee(b:BattleState,selected:()=>boolean,ready:()=>boolean,smoke:(a:Vec3,p:Vec3)=>boolean,onHit?:(hit:MeleeHit)=>void){
 const def=weaponsFor(b.mode).knife as unknown as {damage:number;backstabDamage:number;attackRange:number;attackAngle:number;windupTime:number;activeTime:number;recoveryTime:number;lungeRange:number;lungeCooldown:number;fireRate:number;moveSpeedMul:number;sprintSpeedMul:number};
 let phase:MeleePhase='idle',t=0,held=false,hit=false,lunge:Unit|null=null,lungeLeft=0,lungeCd=0,nextSwing=0,swings=0,lastHit:MeleeHit|null=null,flashUntil=0,flash:'fire'|'hit'|'kill'='fire',kick=0,shake=0;
 const available=()=>b.mode!=='core'&&b.mode!=='gungame';
 const feet=():Vec3=>{const p=b.physics.position(b.playerBody);return [p[0],p[1]-.9,p[2]];};
 const eye=():Vec3=>{const p=feet();return [p[0],p[1]+1.8,p[2]];};
 function pick(range:number){
  if(!b.arena)return null;const p=feet(),origin=eye(),look=[-Math.sin(b.yaw)*Math.cos(b.pitch),Math.sin(b.pitch),-Math.cos(b.yaw)*Math.cos(b.pitch)];let best:{unit:Unit;dist:number;dot:number;point:Vec3}|null=null;
  for(const u of b.arena.units){if(!u.alive||u.hp<=0||u.team==='ally'&&!teamless(b.mode))continue;const q=b.arena.position(u),point:Vec3=[q[0],q[1]+1.2,q[2]],dist=Math.hypot(q[0]-p[0],point[1]-p[1]-1,q[2]-p[2]);if(dist>range||dist<.12)continue;
   const delta=point.map((v,i)=>v-origin[i]) as Vec3,len=Math.hypot(...delta);if(len<.08)continue;const dot=delta.reduce((sum,v,i)=>sum+v*look[i],0)/len;if(dot<Math.cos(def.attackAngle))continue;
   if(b.map.raycast(origin,delta,Math.max(0,len-.12))||smoke(origin,point))continue;
   if(!best||dist<best.dist-.08||Math.abs(dist-best.dist)<=.08&&dot>best.dot)best={unit:u,dist,dot,point};
  }return best;
 }
 function stopLunge(){lunge=null;lungeLeft=0;}
 function cancel(){phase='idle';t=0;hit=false;held=false;stopLunge();kick=shake=0;flashUntil=0;}
 function start(){
  if(!available()||!selected()||!ready()||b.dead||phase!=='idle'||b.elapsed+1e-8<nextSwing)return false;
  phase='windup';t=0;hit=false;stopLunge();nextSwing=b.elapsed+def.fireRate;swings++;b.spawnProtection=0;b.skills?.breakStealth();b.stealthUntil=0;b.ads=false;b.firing=false;b.reload=0;
  if(b.grounded&&lungeCd<=0){const target=pick(def.lungeRange);if(target&&target.dist>def.attackRange+.05){lunge=target.unit;const p=feet(),dy=target.point[1]-p[1]-1,horizontal=Math.hypot(target.point[0]-p[0],target.point[2]-p[2]);lungeLeft=Math.min(def.lungeRange-def.attackRange,Math.max(0,horizontal-Math.sqrt(Math.max(0,def.attackRange**2-dy**2))+.002));lungeCd=def.lungeCooldown;}}
  b.audio?.play('melee_swing');kick+=.07;flash='fire';flashUntil=b.elapsed+.16;return true;
 }
 function resolve(){const target=pick(def.attackRange);if(!target||!b.arena)return false;const back=backstab(feet(),b.arena.position(target.unit),target.unit.yaw||0),damage=back?def.backstabDamage:def.damage;
  b.arena.damage(target.unit,damage,b.arena.player,'knife',false);const killed=!target.unit.alive||target.unit.hp<=0;
  lastHit={target:target.unit.id,damage,backstab:back,killed,position:target.point,at:b.elapsed};onHit?.(lastHit);b.audio?.play(back?'melee_backstab':'melee_hit');flash=killed||back?'kill':'hit';flashUntil=b.elapsed+(flash==='kill'?.28:.17);shake=Math.max(shake,back?.045:.028);kick+=back?.08:.05;
  if(back){b.notice='背刺处决';b.noticeLeft=3;}return true;
 }
 function update(dt:number){
  dt=Math.max(0,dt);lungeCd=Math.max(0,lungeCd-dt);kick*=Math.exp(-12*dt);shake=Math.max(0,shake-dt*.24);
  if(!selected()||!ready()||b.dead){cancel();return;}
  if(lunge){if(!b.grounded||b.keys.has('Space')||!lunge.alive||lunge.hp<=0||b.interacting||b.arena?.traversingPlayer)stopLunge();else{
   const p=feet(),q=b.arena!.position(lunge),x=q[0]-p[0],z=q[2]-p[2],len=Math.hypot(x,z);
   if(len<=def.attackRange*.92)stopLunge();else{const step=Math.min(lungeLeft,10*dt);b.physics.move(b.playerBody,[x/len*step,0,z/len*step]);lungeLeft-=step;if(lungeLeft<=.001)stopLunge();}
  }}
  if(phase==='idle'){if(held)start();return;}
  // Carry elapsed time across boundaries so a slow frame cannot drop the hit window.
  t+=dt;
  if(phase==='windup'&&t+1e-8>=def.windupTime){t=Math.max(0,t-def.windupTime);phase='active';}
  if(phase==='active'){if(!hit)hit=resolve();if(t+1e-8>=def.activeTime){t=Math.max(0,t-def.activeTime);phase='recovery';stopLunge();}}
  if(phase==='recovery'&&t+1e-8>=def.recoveryTime){phase='idle';t=0;if(held)start();}
 }
 return {press(){held=true;return start();},release(){held=false;},cancel,update,
  reset(){cancel();lungeCd=nextSwing=swings=0;lastHit=null;},pose:(rest:Pose)=>slashPose(b.mode,phase,t,def,rest),
  get movementScale(){return selected()?(b.keys.has('ShiftLeft')?def.sprintSpeedMul:def.moveSpeedMul):1;},get kick(){return kick;},get shake(){return shake;},get flash(){return b.elapsed<flashUntil?flash:null;},get busy(){return phase!=='idle';},
  snapshot:()=>({phase,time:t,held,swings,lungeTarget:lunge?.id??null,lungeLeft,lastHit,flash:b.elapsed<flashUntil?flash:null})
 };
}
