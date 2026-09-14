const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');

// Sample the world above the weapon/HUD, excluding the crosshair. A valid HUD
// or submitted frame alone cannot prove that terrain reached the screen.
function worldPixels(buffer) {
  const p = PNG.sync.read(buffer), bins = new Map();
  let samples = 0;
  for (let y = Math.round(p.height * .16); y < p.height * .68; y += 4) {
    for (let x = Math.round(p.width * .26); x < p.width * .80; x += 4) {
      if (Math.abs(x - p.width * .5) < 30 && Math.abs(y - p.height * .5) < 30) continue;
      const i = (y * p.width + x) * 4;
      const key = [0, 1, 2].map(a => p.data[i + a] >> 4).join(',');
      bins.set(key, (bins.get(key) || 0) + 1);
      samples++;
    }
  }
  return {bins: bins.size, dominant: Math.max(...bins.values()) / samples};
}
function assertWorld(pixels, label) {
  assert.ok(pixels.bins >= 20 && pixels.dominant < .88,
    label + ': battlefield is blank or nearly uniform: ' + JSON.stringify(pixels));
}
module.exports = {worldPixels, assertWorld};

async function main() {
  const browserName = process.env.BATTLE_BROWSER || 'chrome';
  const dir = process.env.BATTLE_ARTIFACTS || 'artifacts/battle-visibility-' + browserName;
  fs.mkdirSync(dir, {recursive: true});
  const executablePath = browserName === 'qq'
    ? 'E:/Program Files/Tencent/QQBrowser/QQBrowser.exe'
    : browserName === 'edge'
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    : 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser = await chromium.launch({executablePath, headless: process.env.BATTLE_HEADLESS !== '0'});
  const page = await browser.newPage({viewport: {width: Number(process.env.BATTLE_WIDTH || 1280), height: Number(process.env.BATTLE_HEIGHT || 720)}, deviceScaleFactor: Number(process.env.BATTLE_DPR || 1)});
  const rows = [], errors = [];
  let passed = false, failure = null;
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' || /GL_INVALID|Error compiling|CONTEXT_LOST|shader.*failed/i.test(m.text())) errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url()); });
  const screen = value => page.waitForFunction(v => document.documentElement.dataset.frontlineScreen === v, value, {timeout: 60000});
  try {
    await page.goto(process.env.BATTLE_URL || 'http://localhost:8766/');
    await screen('home');
    await page.locator('#enter-hub-btn').click();
    await screen('modes');
    // The cover suppresses clicks for 500 ms while its transition finishes.
    await page.waitForTimeout(650);
    // Different maps must share one session: identical-map repetition can hide
    // a stale mesh cache because recycled slots happen to contain matching data.
    const modes = (process.env.BATTLE_MODES || 'conquest,core,tdm,demo,ffa,gungame,conquest,gungame,solo').split(',');
    for (const mode of modes) {
      await page.locator(mode === 'conquest' ? '[data-mode-action="conquest32"]' : mode === 'solo' ? '[data-mode-action="solo"]' : '[data-quick-mode="' + mode + '"]').click();
      await page.locator('#class-confirm-btn').click();
      await page.locator('#squad-intro-skip').click();
      await screen('battle');
      const row = {mode, captures: []};
      rows.push(row);
      // Check entry and a later live frame; no forward walk into a wall.
      for (const stage of ['entry', 'live']) {
        if (stage === 'entry') await page.waitForTimeout(3000);
        else {
          await page.waitForFunction(() => ['battle', 'live'].includes(document.querySelector('#game-ui')?.firstElementChild?.dataset.matchPhase), null, {timeout: 120000});
          await page.waitForTimeout(1000);
        }
        const name = rows.length + '-' + mode + '-' + stage;
        const buffer = await page.screenshot({path: dir + '/' + name + '.png'});
        const pixels = worldPixels(buffer);
        row.captures.push({stage, pixels, state: await page.evaluate(() => ({
          screen: document.documentElement.dataset.frontlineScreen,
          frames: document.documentElement.dataset.forgeaxFrameSubmitted,
          ui: Object.fromEntries(['gameRuntime','matchPhase','renderChunks','cameraPosition','health','combatants','shots'].map(k => [k, document.querySelector('#game-ui')?.firstElementChild?.dataset[k]])),
        }))});
        console.log(name, pixels);
        assertWorld(pixels, name);
      }
      await page.keyboard.press('Escape');
      await screen('pause');
      await page.locator('#pause-leave').click();
      await screen('modes');
    }
    assert.deepEqual(errors, []);
    passed = true;
  } catch (error) {
    failure = String(error);
    await page.screenshot({path: dir + '/failure.png', timeout: 3000}).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(dir + '/report.json', JSON.stringify({browser: browserName, version: browser.version(), dpr:Number(process.env.BATTLE_DPR || 1), headed:process.env.BATTLE_HEADLESS === '0', passed, failure, rows, errors}, null, 2));
    await browser.close();
  }
}
if (require.main === module) main().catch(e => {console.error(e); process.exitCode = 1;});
