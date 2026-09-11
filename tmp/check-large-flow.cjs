const {chromium}=require('playwright');const assert=require('assert/strict');
const fs=require('fs');const outputDir=process.env.VF_UI_OUTPUT||'tmp/frontline-ui-check';fs.mkdirSync(outputDir,{recursive:true});
(async()=>{
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-unsafe-swiftshader']});
try {
const context=await browser.newContext({viewport:{width:1440,height:900}});const errors=[],missing=[];
function watch(page){page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()===404)missing.push(r.url());});}
const page=await context.newPage();watch(page);
await page.goto('http://127.0.0.1:8765/?screen=modes',{waitUntil:'domcontentloaded'});await page.waitForSelector('#mode-overlay:not(.hidden)',{timeout:60000});
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
const returning=await context.newPage();watch(returning);await returning.goto('http://127.0.0.1:8765/modes/small-battle/index.html?mode=tdm',{waitUntil:'domcontentloaded'});await returning.waitForSelector('#class-overlay:not(.hidden)',{timeout:60000});await returning.click('#class-cancel-btn');await returning.waitForSelector('#mode-overlay:not(.hidden)',{timeout:60000});assert(returning.url().includes('screen=modes'));await returning.close();console.log('CANCEL_RETURNS_SHARED_LOBBY ok');
console.log('ERRORS',errors);console.log('MISSING',Array.from(new Set(missing)));assert.equal(errors.length,0);
assert(missing.every(url=>url.endsWith('/assets/music/theme.mp3')),'Unexpected missing resource');
} finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
