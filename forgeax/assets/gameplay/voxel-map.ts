import {meshFromInterleaved} from '@forgeax/engine/geometry';
import type {AssetGuid} from '@forgeax/engine/pack/guid';
import type {MeshAsset} from '@forgeax/engine/types';
export type Vec3=[number,number,number];
export type VoxelHit={cell:Vec3;normal:Vec3;point:Vec3;distance:number;type:number};
const FACES=[
 {n:[0,1,0],v:[[0,1,1],[1,1,1],[1,1,0],[0,1,0]]},
 {n:[0,-1,0],v:[[0,0,0],[1,0,0],[1,0,1],[0,0,1]]},
 {n:[1,0,0],v:[[1,0,0],[1,1,0],[1,1,1],[1,0,1]]},
 {n:[-1,0,0],v:[[0,0,1],[0,1,1],[0,1,0],[0,0,0]]},
 {n:[0,0,1],v:[[0,0,1],[1,0,1],[1,1,1],[0,1,1]]},
 {n:[0,0,-1],v:[[1,0,0],[0,0,0],[0,1,0],[1,1,0]]},
];
export class VoxelMap {
 readonly dirty=new Set<string>();readonly revisions=new Map<string,number>();readonly durability=new Map<number,number>();
 constructor(readonly width:number,readonly height:number,readonly blocks:Uint8Array,readonly ground:Int8Array,readonly terrain:Float32Array,readonly hits:Record<number,number>){if(blocks.length!==width*width*height||ground.length!==width*width||terrain.length!==width*width)throw Error('Original voxel map has invalid dimensions');}
 index(x:number,y:number,z:number){return x<0||y<0||z<0||x>=this.width||z>=this.width||y>=this.height?-1:(y*this.width+z)*this.width+x;}
 get(x:number,y:number,z:number){const i=this.index(x,y,z);return i<0?0:this.blocks[i];}
 solid(x:number,y:number,z:number){const t=this.get(x,y,z);return t!==0&&t!==8&&t!==13&&t!==16&&t!==17;}
 mark(x:number,z:number){const key=Math.floor(x/16)+','+Math.floor(z/16);this.revisions.set(key,(this.revisions.get(key)||0)+1);const cx=Math.floor(x/16),cz=Math.floor(z/16);this.dirty.add(cx+','+cz);if(x%16===0)this.dirty.add((cx-1)+','+cz);if(x%16===15)this.dirty.add((cx+1)+','+cz);if(z%16===0)this.dirty.add(cx+','+(cz-1));if(z%16===15)this.dirty.add(cx+','+(cz+1));}
 set(x:number,y:number,z:number,type:number){const i=this.index(x,y,z);if(i<0||this.blocks[i]===15&&type!==15)return false;this.blocks[i]=type;this.durability.delete(i);this.mark(x,z);return true;}
 breakBlock(x:number,y:number,z:number,force=false){x=Math.floor(x);y=Math.floor(y);z=Math.floor(z);const t=this.get(x,y,z),i=this.index(x,y,z);if(t===0||t===8||t===15||(y<=this.ground[z*this.width+x]&&this.solid(x,y,z)))return false;
  const left=(this.durability.get(i)??this.hits[t]??1)-1;if(!force&&left>0){this.durability.set(i,left);return false;}return this.set(x,y,z,0);
 }
 raycast(origin:Vec3,direction:Vec3,maxDistance:number):VoxelHit|null{
  const length=Math.hypot(...direction);if(length<1e-10||!Number.isFinite(length)||!origin.every(Number.isFinite)||!Number.isFinite(maxDistance)||maxDistance<0)return null;
  const dir=direction.map(v=>v/length),cell=origin.map(Math.floor),step=dir.map(Math.sign),delta=dir.map(v=>v===0?Infinity:Math.abs(1/v));
  const edge=dir.map((v,a)=>v===0?Infinity:((v>0?cell[a]+1:cell[a])-origin[a])/v);let distance=0;let normal:Vec3=[0,0,0];
  while(distance<=maxDistance){const [x,y,z]=cell,type=this.get(x,y,z);if(type!==0&&type!==8)return {cell:[x,y,z],normal,point:origin.map((v,a)=>v+dir[a]*distance) as Vec3,distance,type};
   const a=edge[0]<=edge[1]&&edge[0]<=edge[2]?0:edge[1]<=edge[2]?1:2;distance=edge[a];edge[a]+=delta[a];cell[a]+=step[a];normal=[0,0,0];normal[a]=-step[a];
  }return null;
 }
 overlaps(pos:Vec3,radius=.35,height=2){const [px,py,pz]=pos;if(px-radius<0||pz-radius<0||px+radius>=this.width||pz+radius>=this.width)return true;
  for(let x=Math.floor(px-radius);x<=Math.floor(px+radius-1e-6);x++)for(let z=Math.floor(pz-radius);z<=Math.floor(pz+radius-1e-6);z++)for(let y=Math.floor(py+1e-5);y<=Math.floor(py+height-1e-5);y++)if(this.solid(x,y,z))return true;return false;
 }
 waterSurface(x:number,z:number){x=Math.floor(x);z=Math.floor(z);for(let y=this.height-1;y>=0;y--)if(this.get(x,y,z)===8)return y+1;return 0;}
 walkHeight(x:number,z:number){x=Math.max(0,Math.min(this.width-1,Math.floor(x)));z=Math.max(0,Math.min(this.width-1,Math.floor(z)));for(let y=this.height-1;y>=0;y--)if(this.solid(x,y,z))return y+1;return 0;}
 buildFarTerrain(centerX:number,centerZ:number,material:(block:number)=>AssetGuid):MeshAsset{
  const vertices:number[]=[],groups=new Map<number,number[]>(),step=8;
  const sample=(x:number,z:number)=>{x=Math.min(this.width-1,Math.max(0,x));z=Math.min(this.width-1,Math.max(0,z));return this.terrain[z*this.width+x];};
  for(let z=0;z<this.width;z+=step)for(let x=0;x<this.width;x+=step){
   const chunkX=Math.floor(x/16),chunkZ=Math.floor(z/16);if(Math.abs(chunkX-centerX)<=3&&Math.abs(chunkZ-centerZ)<=3)continue;
   const type=this.get(x,this.ground[z*this.width+x],z)||1,base=vertices.length/8;
   for(const [dx,dz] of [[0,step],[step,step],[step,0],[0,0]]){const xx=x+dx,zz=z+dz,nx=sample(xx-1,zz)-sample(xx+1,zz),nz=sample(xx,zz-1)-sample(xx,zz+1),l=Math.hypot(nx,2,nz);vertices.push(xx,sample(xx,zz)-.05,zz,nx/l,2/l,nz/l,dx/step,dz/step);}
   if(!groups.has(type))groups.set(type,[]);groups.get(type)!.push(base,base+1,base+2,base,base+2,base+3);
  }
  const indices=[...groups.values()].flat(),mesh=meshFromInterleaved(new Float32Array(vertices),new Uint32Array(indices)).unwrap();let offset=0;const materialSlots=[],submeshes=[];
  for(const [type,ids] of groups){const slot=materialSlots.length;materialSlots.push({slotName:'terrain-'+type,defaultMaterial:material(type)});submeshes.push({indexOffset:offset,indexCount:ids.length,vertexCount:vertices.length/8,materialSlot:slot,topology:'triangle-list' as const});offset+=ids.length;}return {...mesh,materialSlots,submeshes};
 }
 buildChunk(cx:number,cz:number,material:(block:number)=>AssetGuid):MeshAsset|null{
  const vertices:number[]=[],groups=new Map<number,number[]>(),x0=cx*16,z0=cz*16;if(x0<0||z0<0||x0>=this.width||z0>=this.width)return null;
  for(let x=x0;x<Math.min(this.width,x0+16);x++)for(let z=z0;z<Math.min(this.width,z0+16);z++)for(let y=0;y<this.height;y++){
   const type=this.get(x,y,z);if(!type)continue;
   for(const f of FACES){const neighbor=this.get(x+f.n[0],y+f.n[1],z+f.n[2]);if(neighbor!==0&&neighbor!==8||type===8&&(neighbor===8||f.n[1]!==1))continue;
    const base=vertices.length/8;for(let i=0;i<4;i++){const v=f.v[i];vertices.push(x+v[0],y+v[1],z+v[2],...f.n,i===1||i===2?1:0,i<2?1:0);}
    if(!groups.has(type))groups.set(type,[]);groups.get(type)!.push(base,base+1,base+2,base,base+2,base+3);
   }
  }
  if(vertices.length===0)return null;const indices=[...groups.values()].flat(),mesh=meshFromInterleaved(new Float32Array(vertices),new Uint32Array(indices)).unwrap();
  let offset=0;const submeshes=[],materialSlots=[];for(const [type,ids] of groups){const slot=materialSlots.length;materialSlots.push({slotName:'block-'+type,defaultMaterial:material(type)});submeshes.push({indexOffset:offset,indexCount:ids.length,vertexCount:vertices.length/8,materialSlot:slot,topology:'triangle-list' as const});offset+=ids.length;}return {...mesh,submeshes,materialSlots};
 }
}
export async function inflateBase64(encoded:string,expected:number):Promise<Uint8Array>{
 const compressed=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));const bytes=new Uint8Array(await new Response(stream).arrayBuffer());if(bytes.length!==expected)throw Error('Original map decompression length mismatch');return bytes;
}
