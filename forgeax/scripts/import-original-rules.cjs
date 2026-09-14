const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..');
const provenance=[];
function read(relative){const bytes=fs.readFileSync(path.join(root,relative));provenance.push({path:relative,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});return bytes.toString('utf8');}
function rules(prefix){const storage=new Map();const env={console,performance,URL,document:{readyState:"loading",addEventListener(){}},addEventListener(){},TextEncoder,TextDecoder,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))}};env.window=env;env.self=env;env.globalThis=env;vm.createContext(env);
 for(const relative of ['js/vendor/three.gltf.global.js',prefix+'feel-config.js',prefix+'voxel-world.js',prefix+'weapon-catalog.js',prefix+'soldier.js',prefix+'weapons.js',prefix+'throwables.js',prefix+'economy.js'])vm.runInContext(read(relative),env,{filename:relative});
 if(prefix.includes('small-battle'))vm.runInContext(read(prefix+'gamemodes.js'),env,{filename:prefix+'gamemodes.js'});
 if(!prefix.includes('small-battle'))vm.runInContext(read(prefix+'gadgets.js'),env,{filename:prefix+'gadgets.js'});
 const vf=env.VF;return {weaponCatalog:vf.WEAPON_CATALOG,weapons:vf.WEAPONS,loadoutOrder:vf.WEAPON_LOADOUT_ORDER,defaultPrimary:vf.DEFAULT_PRIMARY,defaultSecondary:vf.DEFAULT_SECONDARY,classes:vf.Soldier.CLASSES,feel:vf.Feel,modes:vf.GameModes?.list()??[],blocks:vf.BLOCK,blockColors:vf.BLOCK_COLORS,blockHits:vf.BLOCK_HITS,throwables:vf.THROWABLE_CATALOG,economy:{catalog:vf.Economy.CATALOG,rewards:vf.Economy.MATCH_REWARD,defaults:vf.Economy.getMeta()},gadgets:vf.Gadgets?{equipment:vf.Gadgets.GADGET_CATALOG,grenades:vf.Gadgets.GRENADE_CATALOG,melee:vf.Gadgets.MELEE_CATALOG}:null};}
const content={large:rules('js/'),small:rules('modes/small-battle/js/')};
fs.writeFileSync(path.join(__dirname,'../assets/original/rules.ts'),'// Generated from original author code; do not hand-edit.\nexport default '+JSON.stringify(content,null,2)+' as const;\n');
fs.writeFileSync(path.join(__dirname,'../docs/migration/rules-provenance.json'),JSON.stringify({sources:[...new Map(provenance.map(item=>[item.path,item])).values()]},null,2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(content).map(([key,value])=>[key,{weapons:Object.keys(value.weapons).length,classes:value.classes.length,modes:value.modes.map(mode=>mode.id)}]))));
