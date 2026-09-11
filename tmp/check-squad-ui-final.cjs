
const fs=require('fs');for(const p of ['index.html','modes/small-battle/index.html']){let s=fs.readFileSync(p,'utf8');s=s.replace('styles/squad-ui.css?v=1','styles/squad-ui.css?v=2').replace('js/deployment-presentation.js?v=5','js/deployment-presentation.js?v=6').replace('js/frontline-ui.js?v=5','js/frontline-ui.js?v=6');fs.writeFileSync(p,s);}
const {chromium}=require('playwright'),assert=require('assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-unsafe-swiftshader']});try{
 const page=await browser.newPage({viewport:{width:2705,height:1623}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8765/?screen=modes',{waitUntil:'domcontentloaded'});await page.bringToFront();await page.waitForSelector('#mode-overlay:not(.hidden)',{timeout:60000});
 await page.click('[data-mode-action=conquest32]');await page.waitForSelector('#class-overlay:not(.hidden)');
 await page.click('#class-confirm-btn');await page.waitForSelector('#squad-intro-overlay:not(.hidden)');await page.evaluate(()=>clearInterval(VF.UI._squadIntroTimer));await page.waitForTimeout(700);
 await page.screenshot({path:'docs/ui-refactor/squad-large-2705.png'});
 await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(350);await page.screenshot({path:'docs/ui-refactor/squad.png'});
 await page.click('#squad-intro-loadout .deploy-gear-slot:first-child');await page.waitForSelector('#arsenal-overlay:not(.hidden)');
 await page.evaluate(()=>VF.UI._startSquadIntroCountdown(1));await page.waitForTimeout(1400);assert.equal(await page.evaluate(()=>VF.game.running),false);
 await page.evaluate(()=>VF.Arsenal.hide());await page.waitForFunction(()=>VF.game.running);assert.deepEqual(errors,[]);console.log('PASS: final UI screenshot, equipment click, countdown pause, automatic deployment, no page errors.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});

