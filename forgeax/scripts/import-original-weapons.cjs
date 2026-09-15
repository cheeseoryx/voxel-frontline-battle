const fs=require('fs'),vm=require('vm'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..'),out=path.resolve(__dirname,'../assets/original');let seed=0x5745504e;const seededMath=Object.create(Math);seededMath.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};const env={console,performance,TextDecoder,TextEncoder,URL,Math:seededMath};env.window=env;env.self=env;env.globalThis=env;vm.createContext(env);const sources=[];
for(const rel of ['js/vendor/three.gltf.global.js','js/voxel-world.js','js/weapon-catalog.js','js/weapons.js','js/weapon-viewmodels.js','js/soldier.js']){const bytes=fs.readFileSync(path.join(root,rel));sources.push({path:rel,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});let code=bytes.toString('utf8');if(rel==='js/weapon-viewmodels.js')code=code.replace(/addRail\((?!gun[,\)])/g,'addRail(gun,');vm.runInContext(code,env,{filename:rel});}
const models={},poses={};function collect(name,obj){if(obj.userData?.hip)poses[name]={hip:obj.userData.hip,ads:obj.userData.ads||obj.userData.hip};obj.updateMatrixWorld(true);const vertices=[],colors=[],indices=[];obj.traverseVisible(n=>{if(!n.isMesh)return;const g=n.geometry.clone();g.applyMatrix4(n.matrixWorld);const p=g.getAttribute('position'),normal=g.getAttribute('normal'),uv=g.getAttribute('uv'),color=g.getAttribute('color'),base=vertices.length/8,mat=Array.isArray(n.material)?n.material[0]:n.material;for(let i=0;i<p.count;i++){vertices.push(p.getX(i),p.getY(i),p.getZ(i),normal?.getX(i)??0,normal?.getY(i)??1,normal?.getZ(i)??0,uv?.getX(i)??0,uv?.getY(i)??0);colors.push(mat.color.r*(color?.getX(i)??1),mat.color.g*(color?.getY(i)??1),mat.color.b*(color?.getZ(i)??1),mat.opacity??1);}const idx=g.getIndex();for(let i=0;i<(idx?.count??p.count);i++)indices.push(base+(idx?idx.getX(i):i));g.dispose();});models[name]={vertices,colors,indices};}
for(const [id,def] of Object.entries(env.VF.WEAPON_CATALOG)){const {gun}=env.VF.WeaponViewModels.buildGun(def);gun.position.set(0,0,0);gun.rotation.set(0,0,0);collect('gun/'+id,gun);}
for(const team of ['ally','enemy'])for(const cls of env.VF.Soldier.CLASSES){const model=env.VF.Soldier.createViewModel(cls.id,'ak74',{team});model.root.remove(model.gun);collect('arms/'+team+'/'+cls.id,model.root);}

// Export missing equipment without changing the deterministic existing models.
const savedSeed=seed;
function exportKnives(prefix){const before=seed;for(const cls of env.VF.Soldier.CLASSES){const model=env.VF.Soldier.createKnifeViewModel(cls.id,{team:'ally'});collect(prefix+'gadget/'+cls.id+'/knife',model);}seed=before;}
exportKnives('');
for(const id of ['rpg','knife']){const model=env.VF.Soldier.createViewModel('assault',id,{team:'ally'});model.gun.position.set(0,0,0);model.gun.rotation.set(0,0,0);collect('gun/'+id,model.gun);}
for(const cls of env.VF.Soldier.CLASSES)for(const id of ['medkit','ammo','charge','remote','binoculars']){const model=env.VF.Soldier.createGadgetViewModel(cls.id,{team:'ally'});env.VF.Soldier.styleGadgetViewModel(model,id);model.position.set(0,0,0);model.rotation.set(0,0,0);collect('gadget/'+cls.id+'/'+id,model);}
{
 const rel='js/gadgets.js',bytes=fs.readFileSync(path.join(root,rel));sources.push({path:rel,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 env.document={addEventListener(){},getElementById(){return null;},querySelectorAll(){return [];},readyState:'loading'};
 vm.runInContext(bytes.toString(),env,{filename:rel});for(const id of ['medkit','ammo','charge'])collect('deployed/'+id,env.VF.Gadgets._mesh(id,'ally'));
}

const throwSource=fs.readFileSync(path.join(root,'js/throwables.js'));
sources.push({path:'js/throwables.js',sha256:crypto.createHash('sha256').update(throwSource).digest('hex')});vm.runInContext(throwSource.toString(),env,{filename:'js/throwables.js'});
function exportThrowables(prefix,ids){
 const stream=seed;
 for(const cls of env.VF.Soldier.CLASSES)for(const id of ids){const model=env.VF.Soldier.createThrowableViewModel(cls.id,{team:'ally'});env.VF.Throwables._styleHeldItem(model,id);model.position.set(0,0,0);model.rotation.set(0,0,0);collect(prefix+'gadget/'+cls.id+'/'+id,model);}
 for(const id of ids){const model=env.VF.Soldier.createThrowableViewModel(env.VF.Soldier.CLASSES[0].id,{team:'ally'});env.VF.Throwables._styleHeldItem(model,id);const item=model.userData.parts.holder?.children[0]||model.userData.item;item.removeFromParent();item.position.set(0,0,0);item.rotation.set(0,0,0);collect(prefix+'projectile/'+id,item);}
 seed=stream;
}
exportThrowables('',['frag','flash','smoke']);

seed=savedSeed;
for(const rel of ['modes/small-battle/js/weapon-catalog.js','modes/small-battle/js/weapons.js','modes/small-battle/js/weapon-viewmodels.js','modes/small-battle/js/soldier.js']){const bytes=fs.readFileSync(path.join(root,rel));sources.push({path:rel,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});let code=bytes.toString();if(rel.endsWith('weapon-viewmodels.js'))code=code.replace(/addRail\((?!gun[,\)])/g,'addRail(gun,');vm.runInContext(code,env,{filename:rel});}
for(const cls of env.VF.Soldier.CLASSES){const model=env.VF.Soldier.createViewModel(cls.id,'ar');model.root.remove(model.gun);collect('small/arms/'+cls.id,model.root);}
for(const id of Object.keys(env.VF.WEAPONS)){const model=env.VF.Soldier.createViewModel('vanguard',id);model.gun.position.set(0,0,0);model.gun.rotation.set(0,0,0);collect('small/gun/'+id,model.gun);const bare=env.VF.WeaponViewModels.buildGun(env.VF.WEAPONS[id]).gun;bare.position.set(0,0,0);bare.rotation.set(0,0,0);collect('small/inspect/'+id,bare);}
{const rel='modes/small-battle/js/throwables.js',bytes=fs.readFileSync(path.join(root,rel));sources.push({path:rel,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});vm.runInContext(bytes.toString(),env,{filename:rel});}
exportKnives('small/');
exportThrowables('small/',['frag','flash','smoke','semtex','molotov','stun']);
// EQ-03: import the original small C4 factory, after prior deterministic exports.
{const rel='modes/small-battle/js/skills.js',bytes=fs.readFileSync(path.join(root,rel));sources.push({path:rel,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});vm.runInContext(bytes.toString(),env,{filename:rel});}
for(const cls of env.VF.Soldier.CLASSES){const model=env.VF.Soldier.createThrowableViewModel(cls.id);env.VF.Throwables._styleHeldItem(model,'semtex');model.position.set(0,0,0);model.rotation.set(0,0,0);collect('small/gadget/'+cls.id+'/semtex',model);if(cls.id==='vanguard')collect('small/gadget/vanguard/charge',model);}
collect('small/deployed/charge',env.VF.makeC4Mesh());collect('small/projectile/semtex',env.VF.makeC4Mesh());
for(const [name,model] of Object.entries(models))if(!model.vertices.length||!model.indices.length)throw Error('Empty original equipment model: '+name);
fs.writeFileSync(path.join(out,'gadget-poses.ts'),'// Original held equipment poses, exported with weapons.\nexport default '+JSON.stringify(poses)+';\n');
const encoded=Object.fromEntries(Object.entries(models).map(([name,m])=>[name,{vertices:Buffer.from(new Float64Array(m.vertices).buffer).toString('base64'),colors:Buffer.from(new Float64Array(m.colors).buffer).toString('base64'),indices:Buffer.from(new Uint32Array(m.indices).buffer).toString('base64')}]));
fs.writeFileSync(path.join(out,'weapons.ts'),'// Original exact author values encoded to avoid pack-worker parser exhaustion.\nconst encoded='+JSON.stringify(encoded)+';\nconst bytes=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)).buffer;\nexport default {models:Object.fromEntries(Object.entries(encoded).map(([name,m])=>[name,{vertices:Array.from(new Float64Array(bytes(m.vertices))),colors:Array.from(new Float64Array(bytes(m.colors))),indices:Array.from(new Uint32Array(bytes(m.indices)))}]))};\n');fs.writeFileSync(path.join(__dirname,'../docs/migration/weapons-provenance.json'),JSON.stringify({sources,sourceCorrections:[{file:'js/weapon-viewmodels.js',change:'Pass the owning gun to addRail; original callers omit the required first argument and throw.'}],models:Object.fromEntries(Object.entries(models).map(([id,m])=>[id,{vertices:m.vertices.length/8,triangles:m.indices.length/3}]))},null,2));console.log('Original weapons and arm variants: '+Object.keys(models).length);
