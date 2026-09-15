const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const out='artifacts/eq-02';fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({executablePath:'E:/Program Files/Tencent/QQBrowser/QQBrowser.exe',headless:false});const p=await browser.newPage({viewport:{width:1805,height:1083},deviceScaleFactor:1.5});
const result={date:new Date().toISOString(),browser:'QQ, headed, default GPU',fixture:'Isolated browser profile, existing-account save with all six small throwables owned; production storage and unlock rules unchanged',steps:[],errors:[]};
p.on('pageerror',e=>result.errors.push(e.message));p.on('console',m=>{if(m.type()==='error')result.errors.push(m.text().slice(0,1000));});
await p.addInitScript(()=>{if(!localStorage.getItem('eq02_fixture')){localStorage.setItem('vf_small_meta_v1',JSON.stringify({coins:120,ownedWeapons:['ar'],ownedThrowables:['frag','flash','smoke','stun','molotov','semtex'],loadout:{1:'ar',2:'ar',4:'frag'}}));localStorage.setItem('eq02_fixture','1');}});
const read=()=>p.evaluate(()=>{const h=document.querySelector('#game-ui')?.firstElementChild,r=h?.shadowRoot;return {screen:document.documentElement.dataset.frontlineScreen,frame:document.documentElement.dataset.forgeaxFrameSubmitted,equipment:JSON.parse(h?.dataset.equipment||'null'),health:Number(h?.dataset.health),phase:h?.dataset.matchPhase,yaw:Number(h?.dataset.yaw),pitch:Number(h?.dataset.pitch),locked:!!document.pointerLockElement,position:h?.dataset.playerPosition,status:r?.querySelector('#native-throwable-status')?.textContent,message:r?.querySelector('#native-battle-message')?.textContent};});
async function sample(label){const timing=await p.evaluate(()=>new Promise(resolve=>{const samples=[];let last=performance.now(),start=last;function frame(now){samples.push(now-last);last=now;if(now-start<1600){requestAnimationFrame(frame);return;}samples.sort((a,b)=>a-b);resolve({frames:samples.length,meanMs:(now-start)/samples.length,p95Ms:samples[Math.floor(samples.length*.95)]});}requestAnimationFrame(frame);}));(result.timings??=[]).push({label,...timing});}
async function capture(name){const s=await read();result.steps.push({name,...s});fs.writeFileSync(out+'/qq-throwables.json',JSON.stringify(result,null,2));await p.screenshot({path:out+'/'+name+'.png'});console.log(name,JSON.stringify(s.equipment));return s;}
async function lock(){for(let attempt=0;attempt<6;attempt++){await p.bringToFront();await p.waitForTimeout(350);if((await read()).locked)return;await p.mouse.click(900,400);await p.waitForTimeout(700);if((await read()).locked)return;}throw Error('QQ pointer lock unavailable');}
async function waitBattle(){await p.waitForFunction(()=>document.documentElement.dataset.frontlineScreen==='battle'&&document.querySelector('#game-ui')?.firstElementChild?.dataset.matchPhase==='battle',null,{timeout:120000});await lock();}
async function equip(kind){await p.locator('#class-deploy-loadout [data-native-slot="grenade"]').click();await p.locator('[data-native-item="'+kind+'"]').click();await p.locator('#arsenal-equip').click();await p.locator('#arsenal-back').click();}
async function aim(pitch){const s=await read(),delta=(s.pitch-pitch)/.0022;await p.evaluate(d=>document.dispatchEvent(new MouseEvent('mousemove',{movementY:d,bubbles:true})),delta);}
async function move(key,ms){await p.keyboard.down(key);await p.waitForTimeout(ms);await p.keyboard.up(key);}
async function leave(){await p.keyboard.press('Escape');await p.locator('#pause-leave').click();await p.waitForTimeout(650);}
try{
 await p.goto('http://localhost:8766/');await p.waitForFunction(()=>document.documentElement.dataset.frontlineScreen==='home',null,{timeout:60000});result.ua=await p.evaluate(()=>navigator.userAgent);await p.locator('#enter-hub-btn').click();await p.waitForTimeout(650);
 const cases=process.env.EQ02_VISUAL_ONLY?['smoke','molotov']:['smoke','flash','frag','semtex','molotov','stun'];
 for(const kind of cases){
  const large=['smoke','flash','frag'].includes(kind);await p.locator(large?'[data-mode-action="conquest32"]':'[data-quick-mode="tdm"]').click();await equip(kind);
  await p.screenshot({path:out+'/'+kind+'-selected.png'});await p.locator('#class-confirm-btn').click();await p.locator('#squad-intro-skip').click();await waitBattle();assert.equal((await read()).equipment.loadout.grenade,kind);
  if(kind==='smoke')await sample('before-smoke');
  await aim(-1.1);const key=large?'KeyG':'KeyQ';await p.keyboard.down(key);await p.waitForTimeout(220);await p.keyboard.up(key);if(kind==='semtex'){await p.waitForTimeout(300);await p.mouse.down();await p.waitForTimeout(220);await p.mouse.up();}await p.waitForTimeout(650);
  const shot=await capture(kind+'-released');assert.equal(shot.equipment.grenades,large?1:0);
  if(kind==='smoke'){
   await move('KeyS',1100);await aim(-.12);
   await p.waitForFunction(()=>JSON.parse(document.querySelector('#game-ui').firstElementChild.dataset.equipment).zones.some(z=>z.kind==='smoke'&&z.age>=1.5),null,{timeout:25000});
   await capture('smoke-expanded-outside');await sample('smoke-visible');
   await move('KeyW',1100);await p.waitForTimeout(200);await capture('smoke-entered');
   await p.waitForFunction(()=>JSON.parse(document.querySelector('#game-ui').firstElementChild.dataset.equipment).zones.every(z=>z.kind!=='smoke'),null,{timeout:40000});const expired=await capture('smoke-expired');assert.equal(expired.equipment.smokeOpacity,0);await sample('smoke-expired');
  }else if(kind==='flash'||kind==='stun'){
   // Look toward the nearby impact; flash is directional, stun also changes turn speed.
   await aim(-.15);
   await p.waitForFunction(k=>JSON.parse(document.querySelector('#game-ui').firstElementChild.dataset.equipment)[k]>0,kind,{timeout:15000});
   const state=await capture(kind+'-affected');assert(state.equipment[kind]>0);
   await p.waitForFunction(k=>JSON.parse(document.querySelector('#game-ui').firstElementChild.dataset.equipment)[k]===0,kind,{timeout:20000});await capture(kind+'-recovered');
  }else if(kind==='molotov'){
   await aim(-.3);if(kind==='semtex'){await p.waitForTimeout(3500);assert.equal((await read()).equipment.remoteCount,1);await p.mouse.down({button:'right'});await p.waitForTimeout(180);await p.mouse.up({button:'right'});}await p.waitForFunction(()=>JSON.parse(document.querySelector('#game-ui').firstElementChild.dataset.equipment).zones.some(z=>z.kind==='molotov'),null,{timeout:15000});await move('KeyS',600);await capture('molotov-burning');
   await p.waitForFunction(()=>JSON.parse(document.querySelector('#game-ui').firstElementChild.dataset.equipment).zones.length===0,null,{timeout:20000});await capture('molotov-extinguished');
  }else{
   await aim(-.3);await p.waitForFunction(()=>JSON.parse(document.querySelector('#game-ui').firstElementChild.dataset.equipment).projectiles.length===0,null,{timeout:15000});await capture(kind+'-detonated');
  }
  await leave();
 }
 assert.equal(result.errors.length,0,JSON.stringify(result.errors));result.passed=true;
}catch(e){result.failure=String(e);result.last=await read().catch(()=>null);console.error(e);await p.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{fs.writeFileSync(out+'/qq-throwables.json',JSON.stringify(result,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});