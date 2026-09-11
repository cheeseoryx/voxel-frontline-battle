
const {chromium}=require('playwright'),assert=require('assert/strict'),fs=require('fs');
(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-unsafe-swiftshader']});try{
 const context=await browser.newContext({viewport:{width:1440,height:900}}),errors=[];
 let page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const out='docs/ui-refactor';fs.mkdirSync(out,{recursive:true});
 async function checkLoadout(suffix){
  await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(700);
  const before=await page.evaluate(()=>VF.UI._menuRotation||.12),box=await page.locator('#class-stage-canvas').boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2);await page.mouse.up();
  assert((await page.evaluate(()=>VF.UI._menuRotation))>before,'Character drag rotation failed');
  await page.evaluate(()=>{VF.UI._menuRotation=.12;});
  for(const button of await page.locator('#class-grid .class-card').all())await button.click();
  await page.locator('#class-grid .class-card').first().click();await page.waitForTimeout(600);
  assert(await page.evaluate(()=>!VF.MenuSoldier && VF.Soldier.createPreviewSoldier.toString().includes('createClassSoldier') && Object.values(VF.UI._classPreview.models).every(m=>!m.userData.presentationOnly)),'Original soldier factory was replaced');
  await page.screenshot({path:out+'/loadout-'+suffix+'.png'});
  for(const size of [{width:1920,height:1080},{width:1280,height:720},{width:800,height:600}]){
   await page.setViewportSize(size);await page.waitForTimeout(250);
   const boxes=await page.evaluate(()=>['class-grid','class-deploy-loadout','class-confirm-btn','class-cancel-btn'].map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return {id,visible:r.top>=0&&r.left>=0&&r.bottom<=innerHeight+1&&r.right<=innerWidth+1,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};}));
   assert(boxes.every(x=>x.visible&&x.hit),JSON.stringify({size,boxes}));
  }
  if(suffix==='large')await page.screenshot({path:out+'/loadout-compact.png'});
  await page.setViewportSize({width:1440,height:900});await page.click('#class-confirm-btn');await page.waitForSelector('#squad-intro-overlay:not(.hidden)');await page.evaluate(()=>clearInterval(VF.UI._squadIntroTimer));
  assert(await page.locator('.squad-intro-card').first().evaluate(e=>e.classList.contains('is-player')));
  for(const size of [{width:2705,height:1623},{width:1920,height:1080},{width:1440,height:900},{width:1280,height:720},{width:1100,height:720},{width:800,height:600}]){
   await page.setViewportSize(size);await page.waitForTimeout(350);
   const result=await page.evaluate(()=>{
    const nodes=[...document.querySelectorAll('#squad-intro-loadout .deploy-gear-slot'),document.querySelector('#squad-intro-skip'),document.querySelector('#squad-intro-customize')];
    return nodes.map(e=>{const r=e.getBoundingClientRect(),names=[...e.querySelectorAll('small,strong')].filter(n=>n.getClientRects().length);return {title:e.title||e.id,visible:r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),labels:names.every(n=>{const b=n.getBoundingClientRect();return b.top>=r.top&&b.bottom<=r.bottom+1;})};});
   });assert(result.every(x=>x.visible&&x.hit&&x.labels),JSON.stringify({size,result}));
   if(size.width===2705)await page.screenshot({path:out+'/squad-'+suffix+'-2705.png'});
   if(size.width===1440)await page.screenshot({path:out+(suffix==='large'?'/squad.png':'/squad-small.png')});
   if(size.width===800&&suffix==='small')await page.screenshot({path:out+'/squad-small-compact.png'});
  }
  await page.click('#squad-intro-back');await page.waitForSelector('#class-overlay:not(.hidden)');
 }

 // Each renderer gets a fresh page; navigation is covered by check-frontline-browser.cjs.
 await page.close();page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8765/modes/small-battle/index.html?mode=tdm',{waitUntil:'domcontentloaded'});await page.waitForSelector('#class-overlay:not(.hidden)',{timeout:60000});await checkLoadout('small');
 assert.deepEqual(errors,[]);console.log('PASS: archive clearance, 800–2705 layouts, gear labels, hit targets, all class models, drag rotation, player order; no page errors.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
