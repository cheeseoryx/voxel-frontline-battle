import {Vector3,Quaternion,Euler} from '../original/math.ts';
import {Transform,Name} from '@forgeax/engine/scene';
import {MeshFilter,MeshRenderer,Visibility,VisibilityStateValue} from '@forgeax/engine/render';
import type {World,EntityHandle} from '@forgeax/engine/ecs';
import type {Handle} from '@forgeax/engine/types';
/** A value API over one native entity. Transform is read and written in ECS;
 * this object owns no second transform, children array, or rendering tree. */
export class ActorEntity {
 readonly position:any;readonly rotation:any;
 constructor(readonly world:World,readonly entity:EntityHandle){
  this.position=new Vector3();for(const [i,key] of ['x','y','z'].entries())Object.defineProperty(this.position,key,{get:()=>this.transform().pos[i],set:(v:number)=>{const pos=Array.from(this.transform().pos);pos[i]=v;world.set(entity,Transform,{pos:pos as [number,number,number]}).unwrap();},configurable:true});
  this.rotation={};for(const [i,key] of ['x','y','z'].entries())Object.defineProperty(this.rotation,key,{get:()=>{const q=this.transform().quat,e=new Euler().setFromQuaternion(new Quaternion(...q),'XYZ',false);return [e.x,e.y,e.z][i];},set:(v:number)=>{const e=new Euler().setFromQuaternion(new Quaternion(...this.transform().quat),'XYZ',false);(e as any)[key]=v;const q=new Quaternion().setFromEuler(e);world.set(entity,Transform,{quat:[q.x,q.y,q.z,q.w]}).unwrap();}});
 }
 private transform(){return this.world.get(this.entity,Transform).unwrap();}
 get visible(){return this.world.get(this.entity,Visibility).unwrap().state!==VisibilityStateValue.hidden;}
 set visible(value:boolean){this.world.set(this.entity,Visibility,{state:value?VisibilityStateValue.visible:VisibilityStateValue.hidden}).unwrap();}
}
export function spawnActor(world:World,handle:Handle<'MeshAsset','shared'>,name:string){return new ActorEntity(world,world.spawn({component:Transform,data:{}},{component:Name,data:{value:name}},{component:Visibility,data:{state:VisibilityStateValue.visible}},{component:MeshFilter,data:{assetHandle:handle}},{component:MeshRenderer,data:{materials:[]}}).unwrap());}
