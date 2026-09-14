import {definePack} from '@forgeax/engine/pack/source';
import {terrainPackage,terrainMaterialGuid} from './identity.ts';
import {Materials} from '@forgeax/engine/render';
import {ok,type Asset} from '@forgeax/engine/types';
import colors from './original/terrain-colors.ts';
const linear=(v:number)=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);
export default definePack({schemaVersion:'2.0.0',packageId:terrainPackage,name:'体素战争 / 原版体素材质',build:()=>{
 const outputs:Record<string,Asset>={};for(const [id,hex] of Object.entries(colors))outputs['block/'+id]=Materials.standard({baseColor:[linear((hex>>16&255)/255),linear((hex>>8&255)/255),linear((hex&255)/255),1],roughness:.95,metallic:0});return ok(outputs);
}});
