// Probe: is the small-mode prep countdown actually enforced on player, weapons, skills and AI?
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#enter-hub-btn:not([disabled])', { timeout: 60000 });
    await page.click('#enter-hub-btn');
    await page.waitForSelector('#mode-overlay:not(.hidden)', { timeout: 60000 });
    await page.click('[data-quick-mode=tdm]');
    await page.waitForSelector('#class-overlay:not(.hidden)', { timeout: 60000 });
    await page.click('#class-confirm-btn');
    await page.waitForSelector('#squad-intro-overlay:not(.hidden)');
    await page.click('#squad-intro-skip');
    await page.waitForFunction(() => VF.game.running);

    const sample = async (label) => {
      const s = await page.evaluate(() => {
        const p = VF.game.player;
        const pos = p.object.position;
        const bot = (VF.game.ai.red || [])[0];
        return {
          frozen: !!(VF.GameModes.prepFrozen && VF.GameModes.prepFrozen()),
          px: +pos.x.toFixed(3),
          pz: +pos.z.toFixed(3),
          locomotionLocked: p._locomotionLocked(),
          canDash: VF.game.skills ? VF.game.skills._canDash() : null,
          botX: bot ? +bot.mesh.position.x.toFixed(3) : null,
          botZ: bot ? +bot.mesh.position.z.toFixed(3) : null,
          ammo: VF.game.weapons ? VF.game.weapons.getAmmo().mag : null,
        };
      });
      console.log(label, JSON.stringify(s));
      return s;
    };

    // Hold W and click-to-fire while the prep countdown is still running.
    await page.evaluate(() => {
      VF.game.player.keys['KeyW'] = true;
    });
    const a = await sample('PREP_START ');
    for (let i = 0; i < 12; i++) await page.evaluate(() => VF.game.weapons && VF.game.weapons.tryFire());
    await page.waitForTimeout(1200);
    const b = await sample('PREP_1200ms');
    console.log(
      'during prep  moved=',
      Math.hypot(b.px - a.px, b.pz - a.pz).toFixed(3),
      'botMoved=',
      a.botX == null ? 'n/a' : Math.hypot(b.botX - a.botX, b.botZ - a.botZ).toFixed(3),
      'ammoSpent=',
      a.ammo - b.ammo
    );

    // Let the countdown expire, then confirm everything unfreezes.
    await page.waitForFunction(() => !VF.GameModes.prepFrozen(), { timeout: 30000 });
    const c = await sample('LIVE_START ');
    await page.waitForTimeout(1200);
    const d = await sample('LIVE_1200ms');
    console.log(
      'after prep   moved=',
      Math.hypot(d.px - c.px, d.pz - c.pz).toFixed(3),
      'botMoved=',
      c.botX == null ? 'n/a' : Math.hypot(d.botX - c.botX, d.botZ - c.botZ).toFixed(3)
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
