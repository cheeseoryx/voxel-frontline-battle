import {buildHits} from './class-skill-rules.ts';
import type {BattleState} from './battle.plugin.ts';
import type {Vec3} from './voxel-map.ts';
import tower from '../original/tower-blueprint.ts';
export function constructionCells(kind:'cover'|'tower',anchor:Vec3,quarter:number){const offsets=kind==='tower'?tower:Array.from({length:24},(_,i)=>[Math.floor(i/4)-2,i%4,0,4]);const q=((quarter%4)+4)%4;return offsets.map(([x,y,z,type])=>{const rx=q===0?x:q===1?-z:q===2?-x:z,rz=q===0?z:q===1?x:q===2?-z:-x;return [Math.floor(anchor[0])+rx,Math.floor(anchor[1])+y,Math.floor(anchor[2])+rz,type] as [number,number,number,number];});}
export function createBuilding(b:BattleState){let kind:'cover'|'tower'|null=null,quarter=0;const arena=b.arena!;
 function aim(){const p=b.physics.position(b.playerBody),origin:Vec3=[p[0],p[1]+.9,p[2]],d:Vec3=[-Math.sin(b.yaw)*Math.cos(b.pitch),Math.sin(b.pitch),-Math.cos(b.yaw)*Math.cos(b.pitch)],hit=b.map.raycast(origin,d,kind==='tower'?24:12);if(!hit)return null;return hit.point.map((n,i)=>Math.floor(n+hit.normal[i]*.1)) as Vec3;}
 function place(){if(!kind||!arena.match.scoringLive()||b.dead)return;const anchor=aim();if(!anchor){b.notice='瞄准可建造的地面';b.noticeLeft=2;return;}if(kind==='cover'&&b.buildBlocks<2||kind==='tower'&&b.buildCores<1){b.notice=kind==='cover'?'需要 2 份掩体建材':'需要 1 个部署核';b.noticeLeft=2;return;}const cells=constructionCells(kind,anchor,quarter),people=[arena.player,...arena.units].filter(u=>u.alive).map(u=>arena.position(u));
  for(const [x,y,z] of cells){if(b.map.index(x,y,z)<0||b.map.get(x,y,z)!==0||people.some(p=>Math.abs(p[0]-x-.5)<.85&&Math.abs(p[2]-z-.5)<.85&&y<p[1]+1.8&&y+1>p[1])||arena.objectives.some(o=>Math.hypot(o.position[0]-x,o.position[2]-z)<4)){b.notice='空间被占用，移动准星选择空地';b.noticeLeft=2;return;}}
  // Validate the whole footprint before committing any voxel or spending resources.
  for(const [x,y,z,type] of cells){b.map.set(x,y,z,type);b.map.durability.set(b.map.index(x,y,z),buildHits(b.classId));}if(kind==='cover')b.buildBlocks-=2;else b.buildCores--;b.notice=kind==='cover'?'掩体已建造':'防御塔已建造';b.noticeLeft=2;
 }
 return {select:(next:'cover'|'tower')=>{if(b.mode==='core'){kind=kind===next?null:next;quarter=Math.round(b.yaw/(Math.PI/2));}},cancel:()=>{kind=null;},rotate:()=>{quarter++;},place,get active(){return kind!==null;},hint:()=>kind?(kind==='cover'?'掩体':'防御塔')+' · 瞄准地面并左键建造 / R 旋转 / 1 返回武器':''};
}
