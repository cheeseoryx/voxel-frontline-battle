import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const target='F:/ForgeaX/forgeax-voxel-game';
const require=createRequire(fs.realpathSync(path.join(target,'node_modules/@forgeax/engine/package.json')));
const packages=['app','assets-runtime','devkit','physics-rapier3d','render','rhi-wgpu','shader'];
const patches={};const report=[];
function walk(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);}
for(const name of packages){
 const packageName='@forgeax/engine-'+name;
 const installed=path.dirname(require.resolve(packageName+'/package.json'));
 const local='F:/voxel-frontline-battle/forgeax-engine/packages/'+name;
 const work=path.join(target,'artifacts/engine-patch-build',name);
 fs.mkdirSync(work,{recursive:true});
 const changed=[];
 for(const sub of ['dist','src']){
  if(!fs.existsSync(path.join(local,sub)))continue;
  for(const f of walk(path.join(local,sub))){
   if(f.endsWith('.tsbuildinfo')||f.endsWith('.map'))continue;
   const rel=sub+'/'+f,oldPath=path.join(installed,rel),newPath=path.join(local,rel);
   if(!fs.existsSync(oldPath))continue;
   const old=fs.readFileSync(oldPath),next=fs.readFileSync(newPath);
   if(old.equals(next))continue;
   for(const [folder,bytes] of [['a',old],['b',next]]){const dest=path.join(work,folder,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);}
   changed.push(rel);
  }
 }
 // Newly introduced watcher source is imported by the patched DevKit source.
 if(name==='devkit')for(const rel of ['src/live-dev-watch.ts','src/__tests__/live-dev-watch.unit.test.ts']){
  if(!fs.existsSync(path.join(installed,rel))){for(const folder of ['a','b'])fs.mkdirSync(path.join(work,folder,path.dirname(rel)),{recursive:true});fs.copyFileSync(path.join(local,rel),path.join(work,'b',rel));changed.push(rel);}
 }
 const diff=spawnSync('git',['diff','--no-index','--no-ext-diff','--binary','--','a','b'],{cwd:work,encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true});
 if(![0,1].includes(diff.status))throw Error(diff.stderr);
 const patch=diff.stdout.replaceAll('a/a/','a/').replaceAll('b/b/','b/');
 if(!patch)continue;
 const file='patches/engine-'+name+'-0.1.28.patch';fs.mkdirSync(path.join(target,'patches'),{recursive:true});fs.writeFileSync(path.join(target,file),patch);
 patches[packageName+'@0.1.28']=file;report.push({package:packageName,files:changed,bytes:Buffer.byteLength(patch)});
}
fs.appendFileSync(path.join(target,'pnpm-workspace.yaml'),'\npatchedDependencies:\n'+Object.entries(patches).map(([k,v])=>`  '${k}': ${v}\n`).join(''));
fs.writeFileSync(path.join(target,'artifacts/engine-patch-build/report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report.map(({package:p,files,bytes})=>({package:p,files:files.length,bytes})),null,2));
