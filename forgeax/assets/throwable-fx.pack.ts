import {definePack} from '@forgeax/engine/pack/source';
import {Materials} from '@forgeax/engine/render';
import {ok,type Asset} from '@forgeax/engine/types';
import {throwableFxPackage} from './identity.ts';
/** Scene-mesh effects use the existing Standard path on all supported render devices. */
export default definePack({schemaVersion:'2.0.0',packageId:throwableFxPackage,name:'体素战争 / 投掷特效',build:()=>{
 const out:Record<string,Asset>={};
 for(const [key,color] of Object.entries({'smoke-low':[.17,.19,.21,1],'smoke-mid':[.25,.28,.3,1],'smoke-high':[.37,.40,.42,1]}))out['material/'+key]=Materials.standard({baseColor:color as [number,number,number,number],roughness:1,metallic:0});
 for(const [key,color]of Object.entries({fire:[1,.19,.015,.58],ember:[1,.7,.12,.9],flash:[1,1,.91,.9],stun:[.3,.72,1,.32],char:[.08,.055,.03,1]}))out['material/'+key]=Materials.unlit(color as [number,number,number,number],{castShadow:false,queue:3000,renderState:{depthWriteEnabled:false,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}});
 return ok(out);
}});
