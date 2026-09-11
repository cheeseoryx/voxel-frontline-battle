const {chromium}=require('playwright');const assert=require('assert/strict');
const fs=require('fs');const outputDir=process.env.VF_UI_OUTPUT||'tmp/frontline-ui-check';fs.mkdirSync(outputDir,{recursive:true});
(async()=>{
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-unsafe-swiftshader']});
try {
const context=await browser.newContext({viewport:{width:1440,height:900}});const errors=[],missing=[];
function watch(page){page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()===404)missing.push(r.url());});}
const host=await context.newPage();watch(host);
await host.goto('http://127.0.0.1:8765/modes/small-battle/index.html?mode=tdm',{waitUntil:'domcontentloaded'});
await host.waitForSelector('#class-overlay:not(.hidden)',{timeout:60000});
await host.waitForTimeout(900);
await host.screenshot({path:outputDir+'/ui-small-loadout.png'});
const overlap=await host.evaluate(()=>{
 const r=id=>document.getElementById(id).getBoundingClientRect();const a=r('class-grid'),b=r('class-confirm-btn'),c=r('class-deploy-loadout');
 return {ctaX:b.x,classesRight:a.right,gearRight:c.right,classesX:a.x};
});
assert(overlap.ctaX>=overlap.classesRight-1,JSON.stringify(overlap));assert(overlap.classesX>=overlap.gearRight-1,JSON.stringify(overlap));
await host.click('#class-confirm-btn');
await host.waitForSelector('#squad-intro-overlay:not(.hidden)');
await host.click('#squad-intro-customize');
await host.waitForSelector('#arsenal-overlay:not(.hidden)');
await host.waitForTimeout(3400);
assert.equal(await host.evaluate(()=>VF.game.running),false);
await host.click('#arsenal-back');
await host.waitForSelector('#squad-intro-overlay:not(.hidden)');
await host.click('#squad-intro-skip');
await host.waitForFunction(()=>VF.game.running);
await host.waitForTimeout(500);
await host.evaluate(()=>{VF.game.ai.enabled=false;});
const before=await host.evaluate(()=>({code:VF.Pvp.roomCode,seed:VF.game.mapSeed,blue:VF.game.ai.blue.length,red:VF.game.ai.red.length,mode:VF.GameModes.currentId()}));
assert.equal(before.blue,11);assert.equal(before.red,12);
console.log('HOST',before);
const directory=await context.newPage();watch(directory);
await directory.goto('http://127.0.0.1:8765/',{waitUntil:'domcontentloaded'});await directory.waitForSelector('#enter-hub-btn:not([disabled])',{timeout:60000});await directory.click('#enter-hub-btn');await directory.waitForSelector('#mode-overlay:not(.hidden)',{timeout:60000});await directory.click('[data-mode-action=servers]');await directory.waitForSelector('[data-server-runtime=small][data-server-mode-id=tdm]');await directory.close();
const guest=await context.newPage();watch(guest);
await guest.goto('http://127.0.0.1:8765/modes/small-battle/index.html?mode=tdm',{waitUntil:'domcontentloaded'});
await guest.waitForSelector('#class-overlay:not(.hidden)',{timeout:60000});
const joined=await guest.evaluate(()=>({code:VF.Pvp.roomCode,seed:VF.game.mapSeed,role:VF.Pvp.mode,phase:VF.Pvp.phase,running:VF.game.running}));
assert.equal(joined.code,before.code);assert.equal(joined.seed,before.seed);assert.equal(joined.role,'guest');assert(!joined.running);console.log('GUEST_PREP',joined);
assert.equal(await host.evaluate(()=>VF.game.ai.red.length),12);
await guest.click('#class-confirm-btn');await guest.waitForSelector('#squad-intro-overlay:not(.hidden)');await guest.click('#squad-intro-skip');await guest.waitForFunction(()=>VF.game.running);
await guest.evaluate(()=>{VF.game.ai.enabled=false;});
await host.waitForTimeout(1000);
const after=await host.evaluate(()=>({running:VF.game.running,seed:VF.game.mapSeed,blue:VF.game.ai.blue.length,red:VF.game.ai.red.length,remote:VF.Pvp._remoteDeployed}));
assert(after.running);assert.equal(after.seed,before.seed);assert.equal(after.red,11);console.log('HOST_LATE_JOIN',after);
await guest.close();await host.waitForTimeout(800);
assert.equal(await host.evaluate(()=>VF.game.ai.red.length),12);console.log('LEAVE_REFILL ok');
await host.close();
for(const mode of ['demo','ffa','gungame','core']){
 const page=await context.newPage();watch(page);
 await page.goto('http://127.0.0.1:8765/modes/small-battle/index.html?mode='+mode,{waitUntil:'domcontentloaded'});
 await page.waitForSelector('#class-overlay:not(.hidden)',{timeout:60000});
 await page.click('#class-confirm-btn');await page.waitForSelector('#squad-intro-overlay:not(.hidden)');
 assert.equal(await page.locator('.squad-intro-card').count(),['ffa','gungame'].includes(mode)?1:4);
 await page.click('#squad-intro-skip');await page.waitForFunction(()=>VF.game.running);
 await page.waitForTimeout(250);
 const state=await page.evaluate(()=>({mode:VF.GameModes.currentId(),blue:VF.game.ai.blue.length,red:VF.game.ai.red.length,phase:VF.Pvp.phase,gate:document.querySelector('#pvp-match-ready-overlay').classList.contains('hidden')}));
 assert(state.gate);assert.equal(state.mode,mode);assert.equal(state.phase,'play');console.log('MODE',state);
 await page.close();
}
const page=await context.newPage();watch(page);
await page.goto('http://127.0.0.1:8765/',{waitUntil:'domcontentloaded'});await page.waitForSelector('#enter-hub-btn:not([disabled])',{timeout:60000});await page.click('#enter-hub-btn');await page.waitForSelector('#mode-overlay:not(.hidden)',{timeout:60000});
await page.screenshot({path:outputDir+'/ui-lobby.png'});
await page.click('[data-mode-action=servers]');assert(await page.locator('#server-browser').isVisible());await page.click('[data-mode-action=server-back]');
await page.click('[data-mode-action=solo]');await page.waitForSelector('#class-overlay:not(.hidden)');await page.waitForTimeout(800);await page.screenshot({path:outputDir+'/ui-large-loadout.png'});
for(const size of [{width:1280,height:720},{width:800,height:600}]){
 await page.setViewportSize(size);await page.waitForTimeout(400);await page.screenshot({path:outputDir+'/ui-loadout-'+size.width+'.png'});
 const bounds=await page.evaluate(()=>{const a=document.getElementById('class-confirm-btn').getBoundingClientRect(),b=document.getElementById('class-deploy-loadout').getBoundingClientRect();return {button:a.right<=innerWidth&&a.bottom<=innerHeight&&a.x>=0,gear:b.bottom<=innerHeight&&b.x>=0};});assert(bounds.button);assert(bounds.gear);
}
await page.setViewportSize({width:1440,height:900});await page.click('#class-confirm-btn');await page.waitForSelector('#squad-intro-overlay:not(.hidden)');await page.evaluate(()=>clearInterval(VF.UI._squadIntroTimer));await page.waitForTimeout(500);await page.screenshot({path:outputDir+'/ui-large-squad.png'});
await page.click('#squad-intro-loadout .deploy-gear-slot:first-child');await page.waitForSelector('#arsenal-overlay:not(.hidden)');await page.evaluate(()=>VF.UI._startSquadIntroCountdown(1));await page.waitForTimeout(1600);assert.equal(await page.evaluate(()=>VF.UI.squadIntroOpen),true);await page.evaluate(()=>VF.Arsenal.hide());await page.evaluate(()=>clearInterval(VF.UI._squadIntroTimer));
await page.click('#squad-intro-back');await page.waitForSelector('#class-overlay:not(.hidden)');await page.click('#class-cancel-btn');await page.waitForSelector('#mode-overlay:not(.hidden)');
await page.click('[data-mode-action=conquest32]');await page.waitForSelector('#class-overlay:not(.hidden)');assert.equal(await page.evaluate(()=>VF.game.mode),'pvp');
await page.click('#class-confirm-btn');await page.waitForSelector('#squad-intro-overlay:not(.hidden)');await page.click('#squad-intro-customize');await page.waitForSelector('#loadout-customize-overlay:not(.hidden)');await page.waitForTimeout(3200);assert.equal(await page.evaluate(()=>VF.game.running),false);
await page.click('#loadout-customize-cancel');await page.waitForFunction(()=>VF.game.running,{timeout:10000});console.log('LARGE_QUICK_AUTO_DEPLOY ok');
const returning=await context.newPage();watch(returning);await returning.goto('http://127.0.0.1:8765/modes/small-battle/index.html?mode=tdm',{waitUntil:'domcontentloaded'});await returning.waitForSelector('#class-overlay:not(.hidden)',{timeout:60000});await returning.click('#class-cancel-btn');await returning.waitForSelector('#mode-overlay:not(.hidden)',{timeout:60000});assert(!returning.url().includes('screen=modes'));await returning.close();console.log('CANCEL_RETURNS_SHARED_LOBBY ok');
console.log('ERRORS',errors);console.log('MISSING',Array.from(new Set(missing)));assert.equal(errors.length,0);
assert(missing.every(url=>url.endsWith('/assets/music/theme.mp3')),'Unexpected missing resource');
} finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
