import {definePack} from '@forgeax/engine/pack/source';
import {meshFromInterleaved} from '@forgeax/engine/geometry';
import {Materials} from '@forgeax/engine/render';
import {ok,type Asset} from '@forgeax/engine/types';
import {vehiclePackage,vehicleGuid} from './identity.ts';
import source from './original/vehicles.ts';

// Original soldiers use flat per-part materials. Preserve those exact linear
// colors in material slots, merging only triangles with identical colors.
export default definePack({schemaVersion:'2.0.0',packageId:vehiclePackage,name:'体素战争 / 载具',build:()=>{
 const outputs:Record<string,Asset>={};
 for(const [name,data] of Object.entries(source.models)){
  const palette=new Map<string,{color:[number,number,number,number],indices:number[]}>();
  for(let i=0;i<data.indices.length;i+=3){
   const v=data.indices[i]*4,color=data.colors.slice(v,v+4) as [number,number,number,number];
   for(let j=1;j<3;j++)for(let c=0;c<4;c++)if(Math.abs(data.colors[data.indices[i+j]*4+c]-color[c])>1e-6)throw Error('Original triangle has varying colors; flat material conversion is not lossless.');
   const key=color.join(',');if(!palette.has(key))palette.set(key,{color,indices:[]});palette.get(key)!.indices.push(...data.indices.slice(i,i+3));
  }
  const indices=[...palette.values()].flatMap(x=>x.indices);
  const result=meshFromInterleaved(new Float32Array(data.vertices),new Uint32Array(indices));if(!result.ok)return result;
  let offset=0;const materialSlots=[],submeshes=[];
  for(const [i,entry] of [...palette.values()].entries()){
   const key='material/'+name+'/'+i;
   outputs[key]=Materials.standard({baseColor:entry.color,roughness:0.92,metallic:0});
   materialSlots.push({slotName:'original-'+i,sourceKey:key,defaultMaterial:vehicleGuid(key)});
   submeshes.push({indexOffset:offset,indexCount:entry.indices.length,vertexCount:data.vertices.length/8,materialSlot:i,topology:'triangle-list' as const});offset+=entry.indices.length;
  }
  outputs['vehicle/'+name]={...result.value,materialSlots,submeshes};
 }
 return ok(outputs);
}});
