const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto'),zlib=require('zlib');
const root=path.resolve(__dirname,'../..'),sources=[];
const env={console,performance,TextDecoder,TextEncoder,URL,URLSearchParams};env.window=env;env.self=env;env.globalThis=env;vm.createContext(env);
const files=['js/vendor/three.gltf.global.js','js/feel-config.js','js/voxel-world.js','js/props/prop-palette.js','js/props/props-bundle.js','js/props/prop-stamp.js','js/maps/map-terrain.js','js/maps/island-conquest-terrain.js','js/maps/island-conquest-props.js','js/maps/island-conquest.js'];
for(const relative of files){const bytes=fs.readFileSync(path.join(root,relative));sources.push({path:relative,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});vm.runInContext(bytes.toString('utf8'),env,{filename:relative});}
// Authoring export does not build GPU presentation meshes. The original voxel
// terrain and stamp generation execute unchanged, including their normal seed.
env.VF.VoxelWorld.prototype._rebuildAllChunks=function(){};
const world=new env.VF.VoxelWorld(new env.THREE.Scene());
const bytes=Buffer.from(world.blocks),compressed=zlib.gzipSync(bytes,{level:9});
const data={width:world.worldSize,height:world.height,seed:world.mapSeed,name:world._mapName||'荒盆',blocksGzip:compressed.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),groundGzip:zlib.gzipSync(Buffer.from(world.groundY.buffer)).toString('base64'),terrainGzip:zlib.gzipSync(Buffer.from(world.terrainH.buffer)).toString('base64'),bases:world._plannedBases,landmarks:world._plannedLandmarks,colors:env.VF.BLOCK_COLORS,hits:env.VF.BLOCK_HITS,buildings:world.buildings};
fs.writeFileSync(path.join(__dirname,'../assets/original/terrain-colors.ts'),'export default '+JSON.stringify(env.VF.BLOCK_COLORS)+' as const;\n');
fs.writeFileSync(path.join(__dirname,'../assets/original/conquest-map.ts'),'// Generated original map author data.\nexport default '+JSON.stringify(data)+';\n');
fs.writeFileSync(path.join(__dirname,'../docs/migration/map-provenance.json'),JSON.stringify({sources,width:data.width,height:data.height,sha256:data.sha256,bytes:bytes.length,compressedBytes:compressed.length,seed:data.seed},null,2));console.log(JSON.stringify({width:data.width,height:data.height,bytes:bytes.length,compressed:compressed.length,bases:data.bases}));
