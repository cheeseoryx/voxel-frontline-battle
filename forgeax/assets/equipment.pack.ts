import {definePack} from '@forgeax/engine/pack/source';
import {equipmentPackage,equipmentGuid} from './identity.ts';
import {meshFromInterleaved,createSphereGeometry} from '@forgeax/engine/geometry';
import {Materials} from '@forgeax/engine/render';
import {ok,type Asset} from '@forgeax/engine/types';
import source from './original/weapons.ts';
export default definePack({schemaVersion:'2.0.0',packageId:equipmentPackage,name:'体素战争 / 原版枪械',build:()=>{
 const outputs:Record<string,Asset>={};
 for(const [name,data] of Object.entries(source.models)){
  const palette=new Map<string,{color:[number,number,number,number];indices:number[]}>();
  for(let i=0;i<data.indices.length;i+=3){const color=data.colors.slice(data.indices[i]*4,data.indices[i]*4+4) as [number,number,number,number];const key=color.join(',');if(!palette.has(key))palette.set(key,{color,indices:[]});palette.get(key)!.indices.push(...data.indices.slice(i,i+3));}
  const indices=[...palette.values()].flatMap(p=>p.indices),mesh=meshFromInterleaved(new Float32Array(data.vertices),new Uint32Array(indices)).unwrap();
  let offset=0;const materialSlots=[],submeshes=[];for(const [i,p] of [...palette.values()].entries()){const key='material/'+p.color.join('/');outputs[key]=p.color[3]<.99?Materials.unlit(p.color,{castShadow:false,queue:3000,renderState:{depthWriteEnabled:false,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}}):Materials.standard({baseColor:p.color,roughness:.92,metallic:0});materialSlots.push({slotName:'original-'+i,defaultMaterial:equipmentGuid(key)});submeshes.push({indexOffset:offset,indexCount:p.indices.length,vertexCount:data.vertices.length/8,materialSlot:i,topology:'triangle-list' as const});offset+=p.indices.length;}
  outputs[name]={...mesh,materialSlots,submeshes};
   if(name.startsWith('small/gun/')||name.startsWith('small/arms/ghost')||name.startsWith('small/gadget/ghost/')){const slots=materialSlots.map((slot,i)=>{const p=[...palette.values()][i],key='stealth-material/'+p.color.join('/');outputs[key]=Materials.unlit([p.color[0],p.color[1],p.color[2],.18],{castShadow:false,queue:3000,renderState:{depthWriteEnabled:false,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}});return {...slot,defaultMaterial:equipmentGuid(key)};});outputs['stealth/'+name]={...mesh,materialSlots:slots,submeshes};}
 }
 for(const [name,color,size] of [['melee-hit',[1,.133,.016,1],.18],['melee-backstab',[1,.723,.133,1],.28]] as const){const materialKey='effect/'+name+'-material';outputs[materialKey]=Materials.standard({baseColor:[...color],emissive:[color[0],color[1],color[2]],roughness:1});outputs['effect/'+name]={...createSphereGeometry(size,4,4).unwrap(),materialSlots:[{slotName:'impact',defaultMaterial:equipmentGuid(materialKey)}]};}
 outputs['skill/fx']={...createSphereGeometry(1,4,4).unwrap(),materialSlots:[{slotName:'skill',defaultMaterial:equipmentGuid('skill/fx-material')}]};outputs['skill/fx-material']=Materials.standard({baseColor:[.3,.8,.95,1],emissive:[.3,.8,.95],roughness:1});
 return ok(outputs);
}});
