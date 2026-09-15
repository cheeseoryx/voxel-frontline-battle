import type {World,EntityHandle} from '@forgeax/engine/ecs';
import {Transform} from '@forgeax/engine/scene';
import {MeshFilter,MeshRenderer} from '@forgeax/engine/render';
import {meshFromInterleaved,createSphereGeometry} from '@forgeax/engine/geometry';
import type {Handle,MeshAsset} from '@forgeax/engine/types';
import {throwableFxGuid} from '../identity.ts';
import type {BattleState} from './battle.plugin.ts';
import type {Vec3} from './voxel-map.ts';
import {smokeState,type ThrowableKind} from './throwable-rules.ts';
import type {ThrowableZone,ThrowableVisuals} from './throwable-effects.ts';
const FACES=[
 {n:[0,1,0],v:[[0,1,1],[1,1,1],[1,1,0],[0,1,0]]},{n:[0,-1,0],v:[[0,0,0],[1,0,0],[1,0,1],[0,0,1]]},
 {n:[1,0,0],v:[[1,0,0],[1,1,0],[1,1,1],[1,0,1]]},{n:[-1,0,0],v:[[0,0,1],[0,1,1],[0,1,0],[0,0,0]]},
 {n:[0,0,1],v:[[1,0,1],[1,1,1],[0,1,1],[0,0,1]]},{n:[0,0,-1],v:[[0,0,0],[0,1,0],[1,1,0],[1,0,0]]}
];
/** One closed surface, hidden interior faces removed. Built once per cloud. */
export function smokeMesh(b:Pick<BattleState,'map'>,p:Vec3):MeshAsset{
 const cell=.35,occupied=new Set<string>(),vertices:number[]=[],indices:number[][]=[[],[],[]];
 const key=(x:number,y:number,z:number)=>x+','+y+','+z;
 const lobes=[[0,1.5,0,2.9,1.7]];
 for(let i=0;i<14;i++){const a=i*2.39996,r=i<9?3.1:1.7;lobes.push([Math.cos(a)*r,1.05+(i%4)*.25,Math.sin(a)*r,1.45+(i%3)*.18,1.0+(i%3)*.16]);}
 for(let x=-14;x<=14;x++)for(let z=-14;z<=14;z++)for(let y=0;y<10;y++){
  const px=(x+.5)*cell,pz=(z+.5)*cell,py=(y+.5)*cell;
  if(Math.hypot(px,pz)>4.95||!lobes.some(([lx,ly,lz,rx,ry])=>((px-lx)**2+(pz-lz)**2)/(rx*rx)+(py-ly)**2/(ry*ry)<1))continue;
  const q:Vec3=[p[0]+px,p[1]+py,p[2]+pz];
  if(b.map.solid(...q.map(Math.floor) as Vec3)||b.map.raycast([p[0],p[1]+.3,p[2]],[px,py-.3,pz],Math.hypot(px,py-.3,pz)-.15))continue;
  occupied.add(key(x,y,z));
 }
 for(const k of occupied){const [x,y,z]=k.split(',').map(Number);for(const f of FACES){if(occupied.has(key(x+f.n[0],y+f.n[1],z+f.n[2])))continue;const base=vertices.length/8;for(const [i,v]of f.v.entries())vertices.push((x+v[0])*cell,(y+v[1])*cell,(z+v[2])*cell,...f.n,i===1||i===2?1:0,i>=2?1:0);indices[Math.max(0,Math.min(2,Math.floor((y+Math.sin(x*.7)*1.5+Math.cos(z*.65))/3.4)))].push(base,base+1,base+2,base,base+2,base+3);}}
 // A near-wall impact can leave no empty sample. A small native sphere remains
 // visible at the impact; this is authored geometry, not a renderer fallback.
 if(!vertices.length)return {...createSphereGeometry(.3,8,6).unwrap(),materialSlots:[{slotName:'smoke',defaultMaterial:throwableFxGuid('smoke-low')}]};
 const mesh=meshFromInterleaved(new Float32Array(vertices),new Uint32Array(indices.flat())).unwrap();let offset=0;
 return {...mesh,materialSlots:['smoke-low','smoke-mid','smoke-high'].map(name=>({slotName:name,defaultMaterial:throwableFxGuid(name)})),submeshes:indices.map((a,i)=>{const s={indexOffset:offset,indexCount:a.length,vertexCount:vertices.length/8,materialSlot:i,topology:'triangle-list' as const};offset+=a.length;return s;}).filter(s=>s.indexCount>0)};
}
/** A few merged mesh layers, no per-frame geometry rebuild or particle uploads. */
export function createThrowableVisuals(world:World,b:BattleState):ThrowableVisuals{
 type Effect={zone?:ThrowableZone;entities:EntityHandle[];meshes:Handle<'MeshAsset','shared'>[];age:number;kind:ThrowableKind;p:Vec3};
 const effects:Effect[]=[];let closed=false;
 const spawnMesh=(mesh:MeshAsset,p:Vec3,scale:Vec3):[EntityHandle,Handle<'MeshAsset','shared'>]=>{const h=world.allocSharedRef('MeshAsset',mesh),e=world.spawn({component:Transform,data:{pos:p,scale}},{component:MeshFilter,data:{assetHandle:h}},{component:MeshRenderer,data:{materials:[]}}).unwrap();return [e,h];};
 function removeEffect(e:Effect){for(const entity of e.entities)world.despawn(entity).unwrap();for(const h of e.meshes)world.sharedRefs.release(h).unwrap();effects.splice(effects.indexOf(e),1);}
 function spawn(kind:ThrowableKind,p:Vec3,zone?:ThrowableZone){
  if(closed)return;const e:Effect={kind,p,zone,entities:[],meshes:[],age:0};
  const add=(mesh:MeshAsset,pos:Vec3,scale:Vec3=[1,1,1])=>{const [entity,h]=spawnMesh(mesh,pos,scale);e.entities.push(entity);e.meshes.push(h);};
  if(kind==='smoke')add(smokeMesh(b,p),p,[.02,1,.02]);
  else if(kind==='molotov'){
   // Merge ground patches and irregular tongues into two moving layers.
   for(let layer=0;layer<2;layer++){const v:number[]=[],ids:number[]=[];
    for(let i=0;i<35;i++){const a=i*2.39996,r=2.65*Math.sqrt((i+.5)/35),x=Math.cos(a)*r,z=Math.sin(a)*r;
     const hit=b.map.raycast([p[0]+x,p[1]+.3,p[2]+z],[0,-1,0],2);if(!hit||b.map.raycast([p[0],p[1]+.4,p[2]],[x,0,z],Math.max(0,r-.2)))continue;
     const baseY=hit.point[1]-p[1]+.06,w=layer?.17:.31,h=layer?.35+(i%3)*.1:.55+(i%5)*.18;
     for(const f of FACES){const base=v.length/8;for(const [j,q]of f.v.entries())v.push(x+(q[0]-.5)*w*2*(q[1]>.5?.2:1)+q[1]*Math.sin(i)*.09,baseY+q[1]*h,z+(q[2]-.5)*w*2*(q[1]>.5?.2:1),...f.n,j===1||j===2?1:0,j>=2?1:0);ids.push(base,base+1,base+2,base,base+2,base+3);}
    }
    if(v.length)add({...meshFromInterleaved(new Float32Array(v),new Uint32Array(ids)).unwrap(),materialSlots:[{slotName:'flame',defaultMaterial:throwableFxGuid(layer?'ember':'fire')}]},p);
   }
  }else{
   const key=kind==='flash'?'flash':kind==='stun'?'stun':'fire';
   add({...createSphereGeometry(1,12,8).unwrap(),materialSlots:[{slotName:'burst',defaultMaterial:throwableFxGuid(key)}]},[p[0],p[1]+.35,p[2]],[.12,.12,.12]);
   add({...createSphereGeometry(1,16,6).unwrap(),materialSlots:[{slotName:'wave',defaultMaterial:throwableFxGuid(kind==='flash'?'flash':kind==='stun'?'stun':'ember')}]},[p[0],p[1]+.12,p[2]],[.15,.025,.15]);
  }effects.push(e);
 }
 function update(dt:number){for(const e of [...effects]){e.age+=dt;
  if(e.zone?.kind==='smoke'){const s=smokeState(e.zone.age),scale=Math.max(.002,s.radius/5);world.set(e.entities[0],Transform,{scale:[scale,Math.min(1,.3+scale*.7),scale]}).unwrap();}
  else if(e.zone?.kind==='molotov'){const fade=Math.min(1,e.zone.age/.55,e.zone.life/1.5);e.entities.forEach((entity,i)=>world.set(entity,Transform,{scale:[1,Math.max(.002,fade*(.85+Math.sin(e.age*(i?15:11))*.15)),1]}).unwrap());}
  else if(e.age>.5)removeEffect(e);
  else{const growth=.3+e.age*7,decay=Math.max(.002,1-e.age/.5);world.set(e.entities[0],Transform,{scale:[growth*decay,growth*decay,growth*decay]}).unwrap();world.set(e.entities[1],Transform,{scale:[growth,.035*decay,growth]}).unwrap();}
 }}
 return {spawn,update,remove(id){const e=effects.find(e=>e.zone?.id===id);if(e)removeEffect(e);},dispose(){if(closed)return;closed=true;for(const e of [...effects])removeEffect(e);}};
}
