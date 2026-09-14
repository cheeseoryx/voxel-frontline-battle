const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const {worldPixels, assertWorld} = require('./check-battle-visibility.cjs');

async function main() {
  const dir = process.env.QQ_ARTIFACTS || 'artifacts/qq-preview-dpi-final';
  const dpr = Number(process.env.QQ_DPR || 1.5);
  fs.mkdirSync(dir, {recursive: true});
  const browser = await chromium.launch({executablePath: 'E:/Program Files/Tencent/QQBrowser/QQBrowser.exe', headless: process.env.QQ_HEADLESS !== '0'});
  const page = await browser.newPage({viewport: {width:1805, height:1083}, deviceScaleFactor:dpr});
  const rows = [], errors = [];
  let passed = false, failure = null;
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {if (m.type() === 'error' || /GL_INVALID|Error compiling|CONTEXT_LOST|shader.*failed/i.test(m.text())) errors.push(m.text());});
  page.on('response', r => {if (r.status() >= 400) errors.push(r.status() + ' ' + r.url());});
  const screen = value => page.waitForFunction(v => document.documentElement.dataset.frontlineScreen === v, value, {timeout:60000});
  async function inspect(name, controls) {
    const data = await page.evaluate(ids => {
      const roots = [document];
      for (let i=0;i<roots.length;i++) for (const e of roots[i].querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
      const find = selector => roots.flatMap(r=>[...r.querySelectorAll(selector)])[0];
      const canvas = find('canvas'), r = canvas.getBoundingClientRect();
      const badControls = ids.filter(id => {const e=find(id), b=e?.getBoundingClientRect();return !b || b.width<=0 || b.height<=0 || b.left<-.5 || b.top<-.5 || b.right>innerWidth+.5 || b.bottom>innerHeight+.5;});
      const labels = roots.flatMap(r=>[...r.querySelectorAll('.squad-member-name, .squad-member-heading, .squad-player-tag')]).flatMap(e=>[getComputedStyle(e,'::before').content,getComputedStyle(e,'::after').content,e.matches('.squad-player-tag')?e.textContent:'']).filter(x=>x?.includes('玩家'));
      return {viewport:[innerWidth,innerHeight], dpr:devicePixelRatio, canvas:{css:[r.width,r.height], layout:[canvas.clientWidth,canvas.clientHeight], buffer:[canvas.width,canvas.height], parent:canvas.parentElement.id},badControls,playerLabels:labels.length};
    }, controls);
    assert.deepEqual(data.badControls, [], name + ': controls clipped');
    assert.ok(data.canvas.layout.every((v,i)=>data.canvas.buffer[i]>0 && data.canvas.buffer[i]<=Math.round(v*data.dpr)), name + ': canvas dimensions exceed requested pixels');
    const scale=data.canvas.buffer[0]/data.canvas.layout[0];
    assert.ok(Math.abs(data.canvas.buffer[1]-data.canvas.layout[1]*scale)<=1.5, name + ': canvas aspect mismatch');
    const buffer=await page.screenshot({path:dir+'/'+name+'.png'});
    let modelPixels;
    if (name !== 'battle') {
      const canvas=page.locator('canvas').first();
      const box=await canvas.boundingBox();
      const shown=PNG.sync.read(await page.screenshot({clip:box}));
      const opacity=await canvas.evaluate(e=>{const old=e.style.opacity;e.style.opacity='0';return old;});
      let hidden;
      try { hidden=PNG.sync.read(await page.screenshot({clip:box})); }
      finally { await canvas.evaluate((e,old)=>{e.style.opacity=old;},opacity); }
      let changed=0;
      for(let i=0;i<shown.data.length;i+=4) if(Math.max(...[0,1,2].map(c=>Math.abs(shown.data[i+c]-hidden.data[i+c])))>20) changed++;
      modelPixels=changed/(shown.width*shown.height);
      assert.ok(modelPixels>.06,name+': model is absent; changed pixels='+modelPixels);
    }
    rows.push({name,...data,modelPixels});
    return {data,buffer};
  }
  try {
    await page.goto('http://localhost:8766/'); await screen('home');
    await page.locator('#enter-hub-btn').click(); await screen('modes'); await page.waitForTimeout(650);
    await page.locator('[data-mode-action="conquest32"]').click(); await screen('equipment'); await page.waitForTimeout(1200);
    const cards=page.locator('[data-native-class]');assert.equal(await cards.count(),4);
    for(let i=0;i<4;i++) {await cards.nth(i).click();await page.waitForTimeout(300);await inspect('class-'+i,['#class-confirm-btn','[data-native-class]']);}
    for(const [width,height] of [[1280,720],[2704,1626],[1805,1083]]) {await page.setViewportSize({width,height});await page.waitForTimeout(350);await inspect('equipment-'+width,['#class-confirm-btn']);}
    await page.locator('#class-confirm-btn').click();await screen('deployment');await page.waitForTimeout(250);
    const {data}=await inspect('deployment',['#squad-intro-skip','#squad-intro-cards']);assert.equal(data.playerLabels,1,'player badge duplicated');
    await page.locator('#squad-intro-skip').click();await screen('battle');await page.waitForTimeout(3000);
    const {buffer}=await inspect('battle',[]);assertWorld(worldPixels(buffer),'QQ battlefield');
    assert.deepEqual(errors,[]);passed=true;
  } catch(e) {failure=String(e);await page.screenshot({path:dir+'/failure.png'}).catch(()=>{});throw e;}
  finally {fs.writeFileSync(dir+'/report.json',JSON.stringify({browser:browser.version(),passed,failure,rows,errors},null,2));await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

