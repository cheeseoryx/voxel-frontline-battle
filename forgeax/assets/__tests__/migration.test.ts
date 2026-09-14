import {describe,it,expect} from 'vitest';
import {AssetGuid} from '@forgeax/engine/pack/guid';
import pack from '../soldiers.pack.ts';
import scene from '../scene.pack.ts';
import source from '../original/soldiers.ts';
import {sceneGuid,modelGuid,guidText} from '../identity.ts';

describe('original content migration',()=>{
 it('keeps all original preview and AI variants and original triangle colors',async()=>{
  const r=await Reflect.apply(pack.build,undefined,[{}]);expect(r.ok).toBe(true);
  expect(Object.keys(source.models)).toHaveLength(24);
  for(const [name,data] of Object.entries(source.models)){
   const mesh=r.value['soldier/'+name];expect(mesh.indices.length).toBe(data.indices.length);
   expect(mesh.attributes.position.length/3).toBe(data.vertices.length/8);
   const original=new Map<string,number>();
   for(let i=0;i<data.indices.length;i+=3){const color=data.colors.slice(data.indices[i]*4,data.indices[i]*4+4).join(',');original.set(color,(original.get(color)||0)+1);}
   for(const sub of mesh.submeshes){const material=r.value['material/'+name+'/'+sub.materialSlot];const color=Array.from(material.values.baseColor as number[]).join(',');expect(original.get(color)).toBe(sub.indexCount/3);original.delete(color);}
   expect(original.size).toBe(0);
  }
 });
 it('preserves unit-length original mesh normals',()=>{
  for(const data of Object.values(source.models))for(let i=0;i<data.vertices.length;i+=8){
   expect(Math.hypot(...data.vertices.slice(i+3,i+6))).toBeCloseTo(1,5);
  }
 });
 it('uses project identities and resolvable scene bindings',async()=>{
  const r=await Reflect.apply(scene.build,undefined,[{}]);expect(r.ok).toBe(true);
  const s=r.value['scene/deployment'];expect(s.sourceKey).toBe('scene/deployment');
  expect(s.entities.filter((e:any)=>e.bindingKey?.startsWith('squad/'))).toHaveLength(4);
  expect(s.entities.some((e:any)=>e.bindingKey==='camera')).toBe(true);
  expect(AssetGuid.parse(guidText(sceneGuid)).ok).toBe(true);
  for(const [i,cls] of ['assault','engineer','support','recon'].entries())expect(s.entities[i].components.MeshFilter.assetHandle).toBe(guidText(modelGuid('soldier/ally/'+cls)));
 });
});
