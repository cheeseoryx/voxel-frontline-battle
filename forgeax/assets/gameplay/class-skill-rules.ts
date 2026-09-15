import type {VoxelMap,Vec3} from './voxel-map.ts';
import type {ModeId} from './catalog.ts';
export const CLASS_SKILLS={stim:{cooldown:60,duration:1,heal:100},revive:{range:2.8,duration:3,hp:50,protection:1.5,bleed:28},repair:{range:5,rate:10},heal:{cooldown:15,duration:8,radius:5.5,rate:14},ghost:{cooldown:28,duration:6,speed:1.3,bonus:40,rear:1.3,rearDot:-.25},shield:{cooldown:24,duration:8,hp:280,speed:.65,resist:.94,frontDot:.2},emp:{cooldown:30,range:28,budget:480},turret:{cooldown:40,hp:120,ammo:120,damage:9,interval:1,range:38,cost:12,refund:8},dash:{cooldown:5,duration:.2,distance:30}} as const;
export const weaponClassSpeed=(mode:ModeId,id:string)=>id===(mode==='conquest'?'assault':'vanguard')?1.15:1;
export const classArmor=(mode:ModeId,id:string)=>id===(mode==='conquest'?'support':'medic')?100:50;
export const buildHits=(id:string)=>id==='engineer'?2:1;
export const distance=(a:Vec3,c:Vec3)=>Math.hypot(...a.map((v,i)=>v-c[i]));
export function rearShot(shooter:Vec3,target:Vec3,yaw:number){const x=shooter[0]-target[0],z=shooter[2]-target[2],len=Math.hypot(x,z);return len>.001&&(-Math.sin(yaw)*x-Math.cos(yaw)*z)/len<=-.25;}
/** Original placement: top surface in range, otherwise highest ground below the clamped aim. */
export function skillPlacement(map:VoxelMap,feet:Vec3,dir:Vec3,turret=false):Vec3|null{
 const eye:Vec3=[feet[0],feet[1]+1.8,feet[2]],range=turret?10:8,ray=turret?18:16,hit=map.raycast(eye,dir,ray);let q:Vec3=hit?hit.point.map((v,i)=>v+hit.normal[i]*.05) as Vec3:eye.map((v,i)=>v+dir[i]*ray) as Vec3;
 const d=Math.hypot(q[0]-feet[0],q[2]-feet[2]);if(d>range){q[0]=feet[0]+(q[0]-feet[0])*range/d;q[2]=feet[2]+(q[2]-feet[2])*range/d;}
 if(!(hit&&hit.normal[1]>.55&&d<=range+.05)){let y=Math.min(map.height-1,Math.max(Math.floor(eye[1])+8,Math.floor(feet[1])+12));for(;y>=0;y--)if(map.solid(Math.floor(q[0]),y,Math.floor(q[2]))&&!map.solid(Math.floor(q[0]),y+1,Math.floor(q[2])))break;if(y<0)return null;q[1]=y+1.05;}
 if(map.index(Math.floor(q[0]),Math.floor(q[1]),Math.floor(q[2]))<0)return null;
 if(turret)for(let y=0;y<3;y++)if(map.solid(Math.floor(q[0]),Math.floor(q[1]+y+.2),Math.floor(q[2])))return null;
 return q;
}
/** Structure-only EMP, with the old impact carve then 3D cone and successful-break budget. */
export function empCarve(map:VoxelMap,origin:Vec3,dir:Vec3,home?:Vec3){
 let impact=origin.map((v,i)=>v+dir[i]*19.6) as Vec3;for(let t=.5;t<=28;t+=.35){const q=origin.map((v,i)=>v+dir[i]*t) as Vec3;if(map.solid(...q.map(Math.floor) as Vec3)){impact=q.map((v,i)=>v+dir[i]*.35) as Vec3;break;}}
 const [cx,cy,cz]=impact.map(Math.floor);let broken=0;
 const protectedCell=(x:number,z:number)=>!!home&&Math.abs(x-home[0])<=22&&Math.abs(z-home[2])<=22;
 const cone=(x:number,y:number,z:number,minDot:number,max:number)=>{const v=[x+.5-origin[0],y+.5-origin[1],z+.5-origin[2]],d=Math.hypot(...v);return d<=max&&(d<.4||v.reduce((s,n,i)=>s+n*dir[i],0)/d>=minDot);};
 const cut=(x:number,y:number,z:number)=>{if(broken>=480||protectedCell(x,z))return;if(map.breakBlock(x,y,z,map.get(x,y,z)===6))broken++;};
 for(let x=cx-6;x<cx+6&&broken<480;x++)for(let z=cz-6;z<cz+6&&broken<480;z++)for(let y=cy-3;y<cy+3&&broken<480;y++)if(cone(x,y,z,.15,30))cut(x,y,z);
 for(let t=1;t<=28&&broken<480;t++){const r=Math.ceil(Math.tan(Math.PI/6)*t)+1,[mx,my,mz]=origin.map((v,i)=>Math.floor(v+dir[i]*t));for(let x=mx-r;x<=mx+r&&broken<480;x++)for(let y=my-Math.min(r,8);y<=my+Math.min(r,8)&&broken<480;y++)for(let z=mz-r;z<=mz+r&&broken<480;z++){if(x>=cx-6&&x<cx+6&&y>=cy-3&&y<cy+3&&z>=cz-6&&z<cz+6)continue;if(cone(x,y,z,Math.cos(Math.PI/6),28))cut(x,y,z);}}
 return {broken,impact};
}
