'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=__dirname,read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const c=read('data/content.json'),e=read('data/encounters.json'),b=read('data/backlog.json');
const checks=[];
function check(name,fn){fn();checks.push({name,passed:true});}
function unique(rows,key='id'){assert.equal(new Set(rows.map(x=>x[key])).size,rows.length);}
const byItem=new Map(c.items.map(x=>[x.id,x]));
check('Scope: no meta progression, currency or attachments',()=>{
 assert.equal(c.noMetaProgression,true);assert.equal(c.noAttachments,true);assert.equal(c.currency,false);
 assert.equal(c.runSave.maxActiveRuns,1);
 for(const x of c.items)for(const key of ['attachments','affixes','xp','unlockLevel','price','craftRecipe'])assert(!(key in x));
});
check('Content counts and unique IDs',()=>{
 assert.equal(c.items.length,96);assert.equal(c.weapons.length,12);assert.equal(c.qualities.length,4);assert.equal(c.maps.length,3);
 assert.equal(c.mainContracts.length,9);assert.equal(c.sideContracts.length,12);assert.equal(c.aiRoles.length,8);
 assert.equal(e.bosses.length,3);assert.equal(e.events.length,6);assert.equal(b.length,50);
 [c.items,c.weapons,c.qualities,c.maps,c.mainContracts,c.sideContracts,c.aiRoles,e.bosses,e.events,b].forEach(x=>unique(x));
 assert.deepEqual(Object.fromEntries(Object.keys(e.categoryLabels).map(k=>[k,c.items.filter(x=>x.category===k).length])),
 {weapon:48,equipment:12,ammo:4,recovery:8,throwable:4,utility:4,objective:4,valuable:12});
});
check('Item schema and finite numerical values',()=>{
 for(const x of c.items){assert(x.name&&x.use&&x.source.length);assert(Number.isInteger(x.capacityCost)&&x.capacityCost>0);assert(Number.isInteger(x.maxStack)&&x.maxStack>0);assert(x.score>=0);for(const v of Object.values(x.stats))if(typeof v==='number')assert(Number.isFinite(v));if(!['weapon','equipment'].includes(x.category))assert(!x.quality);}
});
check('Weapons: four fixed tiers and exact formulas',()=>{
 for(const w of c.weapons){
  assert(byItem.has('ammo_'+w.ammo));assert(w.projectilesPerShot>0);assert(w.falloffEndM>w.falloffStartM);
  for(const q of c.qualities){
   const x=byItem.get('weapon_'+w.id+'_'+q.id);assert(x);assert.equal(x.baseId,w.id);assert.equal(x.quality,q.id);
   const round=x=>+x.toFixed(3);
   assert.equal(x.stats.damagePerProjectile,round(w.damagePerProjectile*q.damage));
   assert.equal(x.stats.recoilVerticalDeg,round(w.recoilVerticalDeg*q.recoil));
   assert.equal(x.stats.adsSpreadHalfAngleDeg,round(w.adsSpreadHalfAngleDeg*q.spread));
   assert.equal(x.stats.reloadSeconds,round(w.reloadSeconds*q.reload));
   assert.equal(x.stats.magazine,w.magazine);assert.equal(x.stats.rpm,w.rpm);assert.equal(x.stats.ammo,w.ammo);
  }
 }
});
check('Equipment quality values',()=>{
 for(const q of c.qualities){
  assert.equal(byItem.get('armor_'+q.id).stats.damageReduction,q.armorDR);
  assert.equal(byItem.get('helmet_'+q.id).stats.damageReduction,q.helmetDR);
  assert.equal(byItem.get('backpack_'+q.id).stats.capacity,q.capacity);
 }
});
check('Starting presets: Q1, valid references, 5/12 capacity',()=>{
 for(const p of c.startingPresets){
  for(const field of ['weapon','secondary','armor','helmet','backpack'])assert.equal(byItem.get(p[field]).quality,'q1');
  let used=0;
  for(const [id,n] of Object.entries({...p.reserve,...p.extra})){const x=byItem.get(id);assert(x);assert(n>0);used+=Math.ceil(n/x.maxStack)*x.capacityCost;}
  assert.equal(used,5);assert.equal(byItem.get(p.backpack).stats.capacity,12);assert(p.startWeaponsLoaded);
 }
});
check('Map and contract references, authored graph connectivity',()=>{
 for(const m of c.maps){
  unique(m.landmarks);assert.equal(m.landmarks.length,6);assert.equal(m.extracts.length,3);
  const seen=new Set([1]);let change=true;while(change){change=false;for(const [a,z]of m.routeLinks){assert(a>=1&&a<=6&&z>=1&&z<=6);if(seen.has(a)&&!seen.has(z)){seen.add(z);change=true;}if(seen.has(z)&&!seen.has(a)){seen.add(a);change=true;}}}
  assert.equal(seen.size,6);
  assert.equal(m.extracts[0].unlockSeconds,0);
  for(const id of m.mainContracts){const q=c.mainContracts.find(x=>x.id===id);assert(q&&q.map===m.id);assert(m.landmarks.some(x=>x.id===q.targetPoi));assert.equal(byItem.get(q.requiredItem).category,'objective');assert(q.criticalSpawnGuaranteed);}
  for(const x of m.extracts)if(x.consume)assert(byItem.has(x.consume));
 }
 for(const q of c.sideContracts)assert.equal(q.score,600);
});
check('Loot weights, boss and event budgets',()=>{
 for(const weights of [...Object.values(c.loot.equipmentQualityWeights),c.loot.normalCategoryWeights])assert.equal(Object.values(weights).reduce((a,x)=>a+x,0),100);
 for(const boss of e.bosses){assert(c.maps.some(x=>x.id===boss.map));assert(byItem.has(boss.armor));assert(byItem.has(boss.helmet));assert(byItem.has(boss.guaranteedLoot));assert(c.weapons.some(x=>x.id===boss.weaponBase));assert(boss.optional);}
 assert.equal(e.eventLimits.maxEvents,2);assert.equal(e.eventLimits.maxExtraEnemies,2);assert.equal(e.aiAmmoBudget.refill,false);
});
check('Score cap and worked example',()=>{
 const s=c.score;assert.equal(s.extract+s.main+s.sideCap+s.cargoCap+s.combatCap+s.explorationCap,s.max);
 assert.equal(s.max,10000);assert.equal(700+3000+1200+2100+450+500,7950);assert.equal(s.withoutMainMaxRank,'B');
});
check('Backlog dependencies are valid and acyclic',()=>{
 const map=new Map(b.map(x=>[x.id,x])),done=new Set(),visiting=new Set();
 function visit(id){assert(map.has(id),'Missing task '+id);if(done.has(id))return;assert(!visiting.has(id),'Cycle '+id);visiting.add(id);for(const p of map.get(id).dependsOn)visit(p);visiting.delete(id);done.add(id);}
 for(const x of b){assert(x.status==='planned');assert(x.acceptance);assert(x.effortPersonDays[0]<=x.effortPersonDays[1]);visit(x.id);}
});
check('Readable catalog covers each item once',()=>{
 const txt=fs.readFileSync(path.join(root,'07-完整物品目录.md'),'utf8'),tick=String.fromCharCode(96);
 for(const x of c.items)assert.equal(txt.split(tick+x.id+tick).length-1,1);
});
check('Document package local links and expected files',()=>{
 const names=fs.readdirSync(root).filter(x=>x.endsWith('.md'));assert.equal(names.length,8);
 for(const name of names){const txt=fs.readFileSync(path.join(root,name),'utf8');assert(txt.length>500);for(const m of txt.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){const target=m[1];if(/^(https?:|#)/.test(target))continue;if(target==='validation-report.json')continue;assert(fs.existsSync(path.resolve(root,target)),name+': missing '+target);}}
});
const report={status:'passed',scope:'Design data consistency only; game systems and playtests are not implemented or tested by this script.',checkedAt:new Date().toISOString(),counts:{documents:8,items:c.items.length,weaponBases:c.weapons.length,maps:c.maps.length,mainContracts:c.mainContracts.length,sideContracts:c.sideContracts.length,aiRoles:c.aiRoles.length,bosses:e.bosses.length,events:e.events.length,workPackages:b.length,publishTestCases:32},checks,effortPersonDays:b.reduce((a,x)=>[a[0]+x.effortPersonDays[0],a[1]+x.effortPersonDays[1]],[0,0])};
fs.writeFileSync(path.join(root,'validation-report.json'),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify(report,null,2));
