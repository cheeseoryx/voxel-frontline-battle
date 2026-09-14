import {definePack} from '@forgeax/engine/pack/source';
import {equipmentPackage,equipmentGuid} from './identity.ts';
import {meshFromInterleaved} from '@forgeax/engine/geometry';
import {Materials} from '@forgeax/engine/render';
import {ok,type Asset} from '@forgeax/engine/types';
import source from './original/weapons.ts';
export default definePack({schemaVersion:'2.0.0',packageId:equipmentPackage,name:'体素战争 / 原版枪械',build:()=>{
 const outputs:Record<string,Asset>={};
 for(const [name,data] of Object.entries(source.models)){
  const palette=new Map<string,{color:[number,number,number,number];indices:number[]}>();
  for(let i=0;i<data.indices.length;i+=3){const color=data.colors.slice(data.indices[i]*4,data.indices[i]*4+4) as [number,number,number,number];const key=color.join(',');if(!palette.has(key))palette.set(key,{color,indices:[]});palette.get(key)!.indices.push(...data.indices.slice(i,i+3));}
  const indices=[...palette.values()].flatMap(p=>p.indices),mesh=meshFromInterleaved(new Float32Array(data.vertices),new Uint32Array(indices)).unwrap();
  let offset=0;const materialSlots=[],submeshes=[];for(const [i,p] of [...palette.values()].entries()){const key='material/'+p.color.join('/');outputs[key]=Materials.standard({baseColor:p.color,roughness:.92,metallic:0});materialSlots.push({slotName:'original-'+i,defaultMaterial:equipmentGuid(key)});submeshes.push({indexOffset:offset,indexCount:p.indices.length,vertexCount:data.vertices.length/8,materialSlot:i,topology:'triangle-list' as const});offset+=p.indices.length;}
  outputs[name]={...mesh,materialSlots,submeshes};
 }
 return ok(outputs);
}});
