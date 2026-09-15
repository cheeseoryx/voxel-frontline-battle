// Reproduce check-frontline-browser.cjs line 63 in isolation and report why
// #class-overlay never opens after the 32v32 quick match click.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text());
  });

  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#enter-hub-btn:not([disabled])', { timeout: 60000 });
  await page.click('#enter-hub-btn');
  await page.waitForSelector('#mode-overlay:not(.hidden)', { timeout: 60000 });

  const present = await page.evaluate(() => {
    const el = document.querySelector('[data-mode-action=conquest32]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { visible: r.width > 0 && r.height > 0, text: el.textContent.trim().slice(0, 40) };
  });
  console.log('conquest32 button:', JSON.stringify(present));
  if (!present) {
    console.log('ERRORS', errors);
    await browser.close();
    return;
  }

  await page.click('[data-mode-action=conquest32]');
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({
      classHidden: document.getElementById('class-overlay')?.classList.contains('hidden'),
      mode: window.VF?.game?.mode,
      running: window.VF?.game?.running,
      roomCode: window.VF?.Pvp?.roomCode || null,
      quickBusy: !!window.VF?.Pvp?._quickBusy,
      quickSession: !!window.VF?.Pvp?.quickSession,
      toast: document.getElementById('toast')?.textContent?.trim().slice(0, 60) || null,
      pvpStatus:
        document.querySelector('#pvp-status, .pvp-status')?.textContent?.trim().slice(0, 80) || null,
    }));
    console.log(i + 's', JSON.stringify(st));
    if (st.classHidden === false) break;
  }
  console.log('ERRORS', errors.slice(0, 10));
  await page.screenshot({ path: 'tmp/probe-conquest32.png' });
  await browser.close();
})();
