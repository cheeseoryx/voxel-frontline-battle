/*
 * scripts/check-weapons.js — 枪械美术资产渲染验证
 *
 * 用法：node scripts/check-weapons.js
 * 把 assets/weapons/ 下每把枪渲染成三视图（侧视 / 顶视 / 轴测），
 * 产物 tmp/weapons-check/*.png 用于人工确认枪口朝向与原点位置。
 * 同时打印尺寸、长轴、面数等断言数据。
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'weapons-check');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.json': 'application/json',
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(root, rel || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, port } = await serve();
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const errors = [];
  const summary = [];
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 440 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/scripts/check-weapons.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.WeaponsCheck, null, { timeout: 15000 });

    const ids = await page.evaluate(() => window.WeaponsCheck.ids());
    for (const id of ids) {
      const info = await page.evaluate((sid) => window.WeaponsCheck.render(sid), id);
      assert.equal(info.ok, true, id + ' 渲染失败: ' + (info.reason || ''));
      const file = path.join(outDir, id + '.png');
      await page.locator('#wrap').screenshot({ path: file });
      const bytes = fs.readFileSync(file);
      // 空白画面在 swiftshader 下约 3-6KB，真实渲染 >20KB
      assert.ok(bytes.length > 12000, id + ' 截图疑似空白（' + bytes.length + ' 字节）');
      assert.ok(info.tris > 500, id + ' 面数过低: ' + info.tris);
      summary.push(
        id.padEnd(6) +
          ' 尺寸 ' + info.size.map((v) => v.toFixed(3)).join('×') +
          '  长轴 ' + info.longAxis +
          '  枪口端 ' + info.muzzleEnd +
          ' (半径 -' + info.radNeg.toFixed(3) + ' / +' + info.radPos.toFixed(3) + ')' +
          '  原点 ' + info.originPct.join(' ') +
          '  ' + info.tris + ' tris / ' + info.materials + ' mat'
      );
    }
    log('');
    summary.forEach((s) => log(s));
    log('');
    log('截图: ' + path.relative(root, outDir) + '/');
    if (errors.length) log('\n页面错误:\n' + errors.join('\n'));
  } catch (e) {
    log('失败: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n', 'utf8');
  }
  if (errors.length) process.exitCode = 1;
})();
