import {AssetGuid} from '@forgeax/engine/pack/guid';
import {definePackageId} from '@forgeax/engine/pack/source';
export const IDS={"models":"7447e463-521c-44c5-ab3c-edfcfcdb6477","scene":"1afc1f4d-566b-4ae2-b34c-5d9e3c94bafe","ui":"4360b2ef-2f15-4318-843f-c165ffe8d974"};
export const modelPackage=definePackageId(IDS.models);
export const scenePackage=definePackageId(IDS.scene);
export const modelGuid=(key:string)=>AssetGuid.derive(modelPackage,key);
export const sceneGuid=AssetGuid.derive(scenePackage,'scene/deployment');
export const guidText=AssetGuid.format;
