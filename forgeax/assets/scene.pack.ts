import {definePack} from '@forgeax/engine/pack/source';
import {Camera,DirectionalLight,MeshFilter,MeshRenderer,perspective,ANTIALIAS_FXAA} from '@forgeax/engine/render';
import {Name,Transform} from '@forgeax/engine/scene';
import {ok,type LocalEntityId,type SceneAsset} from '@forgeax/engine/types';
import {scenePackage,modelGuid,guidText} from './identity.ts';
export default definePack({schemaVersion:'2.0.0',packageId:scenePackage,name:'体素战争 / 部署',sceneComponents:[Camera,DirectionalLight,MeshFilter,MeshRenderer,Name,Transform],build:()=>ok({'scene/deployment':{
 kind:'scene',sourceKey:'scene/deployment',entities:[
 ...['assault','engineer','support','recon'].map((cls,i)=>({localId:i as LocalEntityId,bindingKey:'squad/'+i,components:{Name:{value:'原版 '+cls},Transform:{pos:[(i-1.5)*1.85,0,0],quat:[0,1,0,0]},MeshFilter:{assetHandle:guidText(modelGuid('soldier/ally/'+cls))},MeshRenderer:{materials:[]}}})),
 {localId:10 as LocalEntityId,bindingKey:'camera',components:{Name:{value:'部署相机'},Transform:{pos:[0,1.05,5.1]},Camera:{...perspective({fov:Math.PI/4,aspect:16/9,near:0.08,far:100}),antialias:ANTIALIAS_FXAA,clearColor:[0.12,0.16,0.19,1],exposure:1}}},
 {localId:11 as LocalEntityId,components:{Name:{value:'日光'},DirectionalLight:{direction:[0.25,-0.7,-1],color:[1,0.95,0.88],intensity:2.1,castShadow:false}}},
 {localId:12 as LocalEntityId,components:{Name:{value:'环境补光'},DirectionalLight:{direction:[-0.6,-0.2,1],color:[0.58,0.75,1],intensity:1.1,castShadow:false}}}
 ]} satisfies SceneAsset})});

