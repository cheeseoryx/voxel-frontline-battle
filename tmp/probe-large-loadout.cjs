// Measure the large-war equipment footer so the 部署 overflow has numbers behind it.
const { chromium } = require('playwright');
const assert = require('assert');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#enter-hub-btn:not([disabled])', { timeout: 60000 });
  await page.click('#enter-hub-btn');
  await page.waitForSelector('#mode-overlay:not(.hidden)', { timeout: 60000 });
  await page.click('[data-mode-action=solo]');
  await page.waitForSelector('#class-overlay:not(.hidden)');
  await page.waitForTimeout(800);

  for (const size of [
    { width: 1280, height: 720 },
    { width: 800, height: 600 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          x: Math.round(r.x),
          right: Math.round(r.right),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          w: Math.round(r.width),
          h: Math.round(r.height),
          display: cs.display,
          flexWrap: cs.flexWrap,
        };
      };
      const footer = document.querySelector('#class-confirm-btn')?.parentElement;
      const host = document.querySelector('.class-footer, #class-overlay .class-bottom');
      return {
        innerWidth,
        innerHeight,
        footerSel: footer ? footer.id || footer.className : null,
        footerParent: footer && footer.parentElement ? footer.parentElement.className : null,
        footerParentBox: footer && footer.parentElement ? box('.' + footer.parentElement.className.split(' ').join('.')) : null,
        host: host ? host.className : null,
        skinGrid: box('#class-skin-grid'),
        gear: box('#class-deploy-loadout'),
        classGrid: box('#class-grid'),
        confirm: box('#class-confirm-btn'),
        actions: box('.class-actions'),
      };
    });
    console.log(JSON.stringify({ size: size.width, ...info }, null, 1));
  }
  await browser.close();
})();
