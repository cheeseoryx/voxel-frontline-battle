// Probe: does the merged single-page runtime still honour GameModes params in small modes?
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    for (const mode of ['tdm', 'demo', 'ffa']) {
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#enter-hub-btn:not([disabled])', { timeout: 60000 });
      await page.click('#enter-hub-btn');
      await page.waitForSelector('#mode-overlay:not(.hidden)', { timeout: 60000 });
      await page.click('[data-quick-mode=' + mode + ']');
      await page.waitForSelector('#class-overlay:not(.hidden)', { timeout: 60000 });
      await page.click('#class-confirm-btn');
      await page.waitForSelector('#squad-intro-overlay:not(.hidden)');
      await page.click('#squad-intro-skip');
      await page.waitForFunction(() => VF.game.running);
      await page.waitForTimeout(300);
      const state = await page.evaluate(() => {
        const GM = VF.GameModes;
        const slot = (n) => {
          const el = document.querySelector('#hotbar .slot[data-slot="' + n + '"]');
          return el ? !el.classList.contains('hidden') : null;
        };
        const res = document.getElementById('resources');
        return {
          mode: GM.currentId(),
          wantTeamSize: GM.param('teamSize', null),
          wantBuilding: GM.param('building', true),
          wantCombatants: GM.param('combatants', null),
          teamless: !!(GM.isTeamless && GM.isTeamless()),
          actualBlue: VF.game.ai.blue.length,
          actualRed: VF.game.ai.red.length,
          prepFrozen: !!(GM.prepFrozen && GM.prepFrozen()),
          buildingEnabled: !!(VF.game.building && VF.game.building.isEnabled ? VF.game.building.isEnabled() : 'no-isEnabled'),
          buildHasIsEnabled: typeof (VF.game.building && VF.game.building.isEnabled),
          resourcesVisible: res ? !res.classList.contains('hidden') : null,
          knifeSlot3: slot(3),
          buildSlot4: slot(4),
          buildSlot5: slot(5),
          blocks: VF.game.player.blocks,
          cores: VF.game.player.cores,
        };
      });
      console.log(JSON.stringify(state));
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
