/*
 * scripts/check-weapons-side.js — 枪械大图侧视（判定枪口朝向专用）
 *
 * 用法：node scripts/check-weapons-side.js
 * 产物 tmp/weapons-side/<id>.png（1400×520，单把枪一张）
 *
 * 与 check-weapons.js 的分工：
 *   check-weapons.js      三视图，看整体规格（尺寸/长轴/面数/材质）
 *   check-weapons-side.js 单张大侧视，看**握把 / 弹匣 / 枪托 / 枪口**的相对位置，
 *                         用来最终确定「枪口朝 +Z 还是 -Z」。
 *
 * 为什么需要它：check-weapons.js 里那个"长轴细端 = 枪口"的自动判据被证明会误判
 * （M249/MP5/MP7 的枪口端有消焰器/护木段反而更粗；P90/USP 的枪托比握把厚）。
 * 本页刻意**不做自动判断**，只把 +Z 端（青）和 -Z 端（品红）都标出来，人工看图定夺。
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'weapons-side');

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
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1460, height: 600 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/scripts/check-weapons-side.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.WeaponsSide, null, { timeout: 15000 });

    const ids = await page.evaluate(() => window.WeaponsSide.ids());
    for (const id of ids) {
      const info = await page.evaluate((sid) => window.WeaponsSide.render(sid), id);
      assert.equal(info.ok, true, id + ' 渲染失败: ' + (info.reason || ''));
      // 长轴必须永远是 Z —— 不是 Z 就说明导出朝向变了，后面所有 hand-tuned
      // yawOffset / muzzle 偏移都不成立，必须马上发现而不是等真机跑歪。
      assert.equal(info.longAxis, 'Z', id + ' 长轴不是 Z 而是 ' + info.longAxis);
      const file = path.join(outDir, id + '.png');
      await page.locator('#wrap').screenshot({ path: file });
      const bytes = fs.readFileSync(file);
      assert.ok(bytes.length > 20000, id + ' 截图疑似空白（' + bytes.length + ' 字节）');
      log(
        id.padEnd(8) +
          ' 尺寸 ' + info.size.map((v) => v.toFixed(3)).join('×') +
          '  Z ' + info.zMin.toFixed(3) + '…' + info.zMax.toFixed(3) +
          '  原点在 Z 的 ' + info.originPctZ + '% 处'
      );
    }
    log('');
    log('大图侧视: ' + path.relative(root, outDir) + '/');
    log('看图要点：枪口 = 细管端；枪托 = 贴肩宽板端；握把/弹匣 = 朝下伸出的两坨。');
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
