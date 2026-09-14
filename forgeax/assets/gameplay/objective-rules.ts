import type {Vec3} from './voxel-map.ts';
export type Team='ally'|'enemy';
export type Objective={id:string;position:Vec3;owner:Team|null;capture:number;contested:boolean;hp:number};
/** Rule state only; ECS entities and Rapier own presentation and movement. */
export class ObjectiveRules {
 phase='prep';phaseLeft=5;timeLeft:number;score={ally:1000,enemy:1000};ended=false;winner:Team|null=null;endReason='';
 stats:Record<string,any>={};feed:{killer:string;victim:string}[]=[];private bleed=0;sweep={ally:0,enemy:0};
 constructor(readonly mode:'conquest'|'core',readonly objectives:Objective[]){this.timeLeft=mode==='conquest'?2700:Infinity;}
 start(){this.register({id:'player',isPlayer:true,team:'ally'});return this;}
 scoringLive(){return this.phase==='battle'&&!this.ended;}
 register(actor:any){const id=actor.isPlayer?'player':actor.id;return this.stats[id]??=( {id,name:actor.isPlayer?'你':actor.name||id,team:actor.team,kills:0,deaths:0,captures:0,score:0});}
 registerDamage(_victim:any,_amount:number,_attacker:any){}
 registerKill({victim,killer}:any){if(!this.scoringLive())return;this.register(victim).deaths++;if(killer&&killer.team!==victim.team){const k=this.register(killer);k.kills++;k.score+=25;}if(this.mode==='conquest')this.score[victim.team as Team]=Math.max(0,this.score[victim.team as Team]-1);this.feed.unshift({killer:killer?.isPlayer?'你':killer?.name||'环境',victim:victim.isPlayer?'你':victim.name});this.feed.length=Math.min(this.feed.length,6);this.check();}
 ranking(){return Object.values(this.stats).sort((a,b)=>b.score-a.score);}
 playerStats(){return this.stats.player;}
 update(dt:number){if(this.ended)return;if(this.phase==='prep'){this.phaseLeft=Math.max(0,this.phaseLeft-dt);if(!this.phaseLeft)this.phase='battle';return;}this.timeLeft=Math.max(0,this.timeLeft-dt);this.check();}
 occupy(dt:number,actors:{id?:string;name?:string;isPlayer?:boolean;team:Team;position:Vec3;alive:boolean}[]){if(!this.scoringLive()||this.mode!=='conquest')return;
  for(const flag of this.objectives){const nearby=actors.filter(a=>a.alive&&Math.hypot(a.position[0]-flag.position[0],a.position[2]-flag.position[2])<30&&Math.abs(a.position[1]-flag.position[1])<10),blue=nearby.filter(a=>a.team==='ally').length,red=nearby.length-blue;flag.contested=blue>0&&red>0;if(flag.contested)continue;
   if(!blue&&!red){const goal=flag.owner==='ally'?1:flag.owner==='enemy'?-1:0,step=dt*.35/10;flag.capture+=Math.max(-step,Math.min(step,goal-flag.capture));continue;}
   const team:Team=blue?'ally':'enemy',sign=blue?1:-1,step=dt/10*(1+.28*(Math.min(4,blue||red)-1)),previous=flag.owner;flag.capture=Math.max(-1,Math.min(1,flag.capture+sign*step));
   if(flag.owner&&flag.owner!==team&&flag.capture*sign>=0){flag.capture=0;flag.owner=null;}else if(Math.abs(flag.capture)>=1){flag.owner=flag.capture>0?'ally':'enemy';if(previous!==flag.owner)for(const actor of nearby)if(actor.id&&actor.team===flag.owner){const stats=this.register(actor);stats.captures++;stats.score+=100;}}
  }
  const held=(team:Team)=>this.objectives.filter(f=>f.owner===team&&!f.contested&&Math.abs(f.capture)>=.999).length,blue=held('ally'),red=held('enemy');
  if(!blue&&!red)this.bleed=0;else{this.bleed+=dt;while(this.bleed>=3){this.bleed-=3;this.score.enemy=Math.max(0,this.score.enemy-blue);this.score.ally=Math.max(0,this.score.ally-red);}}
  this.sweep.ally=this.objectives.length>0&&blue===this.objectives.length?this.sweep.ally+dt:0;this.sweep.enemy=this.objectives.length>0&&red===this.objectives.length?this.sweep.enemy+dt:0;
  if(this.sweep.ally>=60||this.sweep.enemy>=60){this.ended=true;this.phase='result';this.winner=this.sweep.ally>=60?'ally':'enemy';this.endReason='全点控制持续 60 秒';}else this.check();
 }

 damageCore(team:Team,damage:number,attacker:Team){if(this.mode!=='core'||!this.scoringLive()||team===attacker||damage<=0)return false;this.score[team]=Math.max(0,this.score[team]-damage);const core=this.objectives.find(o=>o.owner===team);if(core)core.hp=this.score[team];this.check();return true;}
 private check(){if(this.ended)return;if(this.score.ally<=0||this.score.enemy<=0||this.timeLeft===0){this.ended=true;this.phase='result';this.winner=this.score.ally===this.score.enemy?null:this.score.ally>this.score.enemy?'ally':'enemy';this.endReason=this.timeLeft===0?'时间结束':this.mode==='core'?'核心已摧毁':'增援兵力耗尽';}}
}
