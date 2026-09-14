const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'../..'), out=path.resolve(__dirname,'../assets/original');
fs.mkdirSync(out,{recursive:true});
let seed=0x4f524947;const math=Object.create(Math);math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const c={console,Math:math,performance,TextDecoder,TextEncoder,URL,URLSearchParams,setTimeout,clearTimeout};c.window=c;c.self=c;c.globalThis=c;
vm.createContext(c);
for(const rel of ['js/vendor/three.gltf.global.js','js/voxel-world.js','js/weapon-catalog.js','js/soldier.js'])vm.runInContext(fs.readFileSync(path.join(root,rel),'utf8'),c,{filename:rel});
const T=c.THREE, models={};
for(const team of ['ally','enemy'])for(const cls of c.VF.Soldier.CLASSES){
 const obj=c.VF.Soldier.createPreviewSoldier(cls.id,{team});obj.updateMatrixWorld(true);
 const vertices=[],colors=[],indices=[];let meshCount=0;
 obj.traverseVisible(n=>{if(!n.isMesh)return;meshCount++;const geo=n.geometry.clone();geo.applyMatrix4(n.matrixWorld);const p=geo.getAttribute('position'),nor=geo.getAttribute('normal'),uv=geo.getAttribute('uv'),col=geo.getAttribute('color');const base=vertices.length/8;
 for(let i=0;i<p.count;i++){vertices.push(p.getX(i),p.getY(i),p.getZ(i),nor?.getX(i)??0,nor?.getY(i)??1,nor?.getZ(i)??0,uv?.getX(i)||0,uv?.getY(i)||0);let m=Array.isArray(n.material)?n.material[0]:n.material;const co=m.color||new T.Color(0xffffff);colors.push(co.r*(col?col.getX(i):1),co.g*(col?col.getY(i):1),co.b*(col?col.getZ(i):1),m.opacity??1);}
 const ix=geo.getIndex();for(let i=0;i<(ix?ix.count:p.count);i++)indices.push(base+(ix?ix.getX(i):i));geo.dispose();});
 models[`${team}/${cls.id}`]={vertices,colors,indices,meshCount};
}
fs.writeFileSync(path.join(out,'soldiers.json'),JSON.stringify({schemaVersion:1,source:'js/soldier.js + js/voxel-world.js',seed:'0x4f524947',models}));
fs.writeFileSync(path.join(out,'classes.json'),JSON.stringify(c.VF.Soldier.CLASSES,null,2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(models).map(([k,m])=>[k,{meshes:m.meshCount,vertices:m.vertices.length/8,triangles:m.indices.length/3}]))));

fs.writeFileSync(path.join(out,'soldiers.ts'),'// Generated author data; no runtime Three.js.\nexport default '+JSON.stringify({models})+';\n');
