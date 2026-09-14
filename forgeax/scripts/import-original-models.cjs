const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..'),out=path.resolve(__dirname,'../assets/original');
const models={},sources=[];
for(const runtime of ['large','small']){
 let seed=0x4f524947;const math=Object.create(Math);math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const env={console,Math:math,performance,TextDecoder,TextEncoder,URL,URLSearchParams};env.window=env;env.self=env;env.globalThis=env;vm.createContext(env);
 const prefix=runtime==='large'?'js/':'modes/small-battle/js/';
 for(const rel of ['js/vendor/three.gltf.global.js',prefix+'voxel-world.js',prefix+'weapon-catalog.js',prefix+'soldier.js']){const bytes=fs.readFileSync(path.join(root,rel));sources.push({path:rel,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});vm.runInContext(bytes.toString('utf8'),env,{filename:rel});}
 const variants=[];for(const team of ['ally','enemy'])for(const cls of env.VF.Soldier.CLASSES)variants.push({key:(runtime==='small'?'small/':'')+team+'/'+cls.id,obj:env.VF.Soldier.createPreviewSoldier(cls.id,{team})});
 if(runtime==='small')for(const id of ['ally','enemy','enemy_heavy','enemy_ranged'])variants.push({key:'small/ai/'+id,obj:env.VF.Soldier.createSoldier(id)});
 for(const {key,obj} of variants){obj.updateMatrixWorld(true);
  const vertices=[],colors=[],indices=[];let meshCount=0;
  obj.traverseVisible(n=>{if(!n.isMesh)return;meshCount++;const geo=n.geometry.clone();geo.applyMatrix4(n.matrixWorld);const p=geo.getAttribute('position'),nor=geo.getAttribute('normal'),uv=geo.getAttribute('uv'),col=geo.getAttribute('color');const base=vertices.length/8;
   for(let i=0;i<p.count;i++){vertices.push(p.getX(i),p.getY(i),p.getZ(i),nor?.getX(i)??0,nor?.getY(i)??1,nor?.getZ(i)??0,uv?.getX(i)||0,uv?.getY(i)||0);const m=Array.isArray(n.material)?n.material[0]:n.material,co=m.color||new env.THREE.Color(0xffffff);colors.push(co.r*(col?col.getX(i):1),co.g*(col?col.getY(i):1),co.b*(col?col.getZ(i):1),m.opacity??1);}
   const ix=geo.getIndex();for(let i=0;i<(ix?ix.count:p.count);i++)indices.push(base+(ix?ix.getX(i):i));geo.dispose();
  });
  models[key]={vertices,colors,indices,meshCount};
 }
 if(runtime==='large')fs.writeFileSync(path.join(out,'classes.json'),JSON.stringify(env.VF.Soldier.CLASSES,null,2));
}
fs.writeFileSync(path.join(out,'soldiers.json'),JSON.stringify({schemaVersion:2,seed:'0x4f524947',models}));
fs.writeFileSync(path.join(out,'soldiers.ts'),'// Generated original author geometry; no runtime Three.js.\nexport default '+JSON.stringify({models})+';\n');
fs.writeFileSync(path.join(__dirname,'../docs/migration/models-provenance.json'),JSON.stringify({sources:[...new Map(sources.map(x=>[x.path,x])).values()],models:Object.fromEntries(Object.entries(models).map(([key,m])=>[key,{meshes:m.meshCount,vertices:m.vertices.length/8,triangles:m.indices.length/3}]))},null,2));
console.log('Converted original model variants: '+Object.keys(models).length);
