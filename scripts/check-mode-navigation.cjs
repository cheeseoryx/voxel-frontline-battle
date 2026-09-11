
const {chromium}=require('playwright'),assert=require('assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-unsafe-swiftshader']});try{
const base='http://127.0.0.1:8765/',context=await browser.newContext({viewport:{width:1440,height:900}}),errors=[],externalScripts=[];
await context.route('**/*',route=>{const u=route.request().url();if(/^https?:/.test(u)&&!u.startsWith(base)){if(route.request().resourceType()==='script')externalScripts.push(u);return route.abort();}return route.continue();});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>localStorage.setItem('vf_small_match_mode_v1','ffa'));
await page.goto(base+'?mode=ffa',{waitUntil:'domcontentloaded'});await page.waitForSelector('#enter-hub-btn:not([disabled])',{timeout:15000});await page.click('#enter-hub-btn');
await page.waitForSelector('#mode-overlay:not(.hidden)');assert(await page.evaluate(()=>!VF.UI.classSelectOpen&&!VF.game.running&&!VF.Pvp.roomCode));
console.log('COVER: remembered FFA and stale mode query do not start a match.');
for(const mode of ['tdm','demo','ffa','gungame','core']){
 let at=Date.now();await page.click('[data-quick-mode="'+mode+'"]');await page.waitForSelector('#class-overlay:not(.hidden)',{timeout:15000});console.log(mode,'prep',Date.now()-at+'ms');assert.equal(await page.evaluate(()=>VF.GameModes.currentId()),mode);
 await page.click('#class-cancel-btn');await page.waitForSelector('#mode-overlay:not(.hidden)',{timeout:15000});assert(page.url().includes('?screen=modes'));
 await page.click('[data-quick-mode="'+mode+'"]');await page.waitForSelector('#class-overlay:not(.hidden)',{timeout:15000});
 const code=await page.evaluate(()=>VF.Pvp.roomCode);await page.click('#class-confirm-btn');await page.waitForSelector('#squad-intro-overlay:not(.hidden)');await page.click('#squad-intro-skip');await page.waitForFunction(()=>VF.game.running,{timeout:15000});
 await page.evaluate(()=>{document.exitPointerLock();});at=Date.now();await page.click('#game-back-btn');await page.waitForSelector('#mode-overlay:not(.hidden)',{timeout:15000});
 assert(!(await page.evaluate(code=>VFEntry.listSmallServers().some(r=>r.code===code),code)),'Leaving seat still advertised');
 console.log(mode,'exit',Date.now()-at+'ms');
}
await page.close();
const hidden=await context.newPage();hidden.on('pageerror',e=>errors.push(e.message));await hidden.addInitScript(()=>{window.requestAnimationFrame=()=>0;});
await hidden.goto(base+'?screen=modes',{waitUntil:'domcontentloaded'});await hidden.waitForSelector('#mode-overlay:not(.hidden)',{timeout:15000});assert(!(await hidden.locator('#game-entry-transition').count()));await hidden.close();
assert.deepEqual(externalScripts,[]);assert.deepEqual(errors,[]);console.log('PASS: same-tab enter/cancel/play/exit for all five modes, no CDN scripts, no stuck transition, RAF-independent startup, no page errors.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
