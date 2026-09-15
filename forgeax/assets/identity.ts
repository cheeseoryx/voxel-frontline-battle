import {AssetGuid} from '@forgeax/engine/pack/guid';
import {definePackageId} from '@forgeax/engine/pack/source';
export const IDS={"models":"7447e463-521c-44c5-ab3c-edfcfcdb6477","scene":"1afc1f4d-566b-4ae2-b34c-5d9e3c94bafe","ui":"4360b2ef-2f15-4318-843f-c165ffe8d974"};
export const modelPackage=definePackageId(IDS.models);
export const scenePackage=definePackageId(IDS.scene);
export const modelGuid=(key:string)=>AssetGuid.derive(modelPackage,key);
export const sceneGuid=AssetGuid.derive(scenePackage,'scene/deployment');
export const guidText=AssetGuid.format;

export const terrainPackage=definePackageId('3fa56ee7-62e1-4460-9c4f-d52b23602a1a');
export const terrainMaterialGuid=(id:number)=>AssetGuid.derive(terrainPackage,'block/'+id);
export const equipmentPackage=definePackageId('eaa1ab9f-5520-42b2-b3fb-f6142c8f0404');
export const equipmentGuid=(key:string)=>AssetGuid.derive(equipmentPackage,key);

export const smallTerrainPackage=definePackageId('d07123a4-ad52-43fb-bfc2-349591502cf9');
export const smallTerrainMaterialGuid=(id:number)=>AssetGuid.derive(smallTerrainPackage,'block/'+id);

export const vehiclePackage=definePackageId('abf003b9-0578-4f18-a8bf-946eca980fe3');
export const vehicleGuid=(key:string)=>AssetGuid.derive(vehiclePackage,key);

export const audioPackage=definePackageId('fc5a27fb-6a94-4205-96ea-af573a5581d4');
export const audioGuid=(key:string)=>AssetGuid.derive(audioPackage,key);

export const throwableFxPackage=definePackageId('40d91c03-b273-445d-b4b3-d1e2eb17455b');
export const throwableFxGuid=(key:string)=>AssetGuid.derive(throwableFxPackage,'material/'+key);
