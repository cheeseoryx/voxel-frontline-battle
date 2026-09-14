import {definePack} from '@forgeax/engine/pack/source';
import {ok,type Asset} from '@forgeax/engine/types';
import {audioPackage} from './identity.ts';
import clips from './original/audio-clips.ts';
export default definePack({schemaVersion:'2.0.0',packageId:audioPackage,name:'体素战争 / 音频',build:()=>{
 const outputs:Record<string,Asset>={};for(const [key,clip] of Object.entries(clips))outputs[key]={kind:'audio',sourceKey:key,mediaType:clip.mediaType as `audio/${string}`,bytes:Uint8Array.from(atob(clip.base64),c=>c.charCodeAt(0))};return ok(outputs);
}});
