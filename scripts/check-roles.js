/*
 * scripts/check-roles.js — 体素角色浏览器验证
 *
 * 用法：node scripts/check-roles.js
 * 断言：
 *   1. 四个皮肤全部预载成功
 *   2. 每个皮肤 create 出蒙皮网格角色（含 Weapon / TeamMarker）
 *   3. 五张截图（box + voxel01..04）两两不同 —— 证明确实换了模型
 *   4. 移动驱动后的截图与待机截图不同 —— 证明动画真的在驱动骨骼
 * 产物：tmp/roles-check/*.png（人工复核朝向/站姿/背枪/贴图）
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'roles-check');

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
  try {
    const page = await browser.newPage({ viewport: { width: 520, height: 700 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/scripts/check-roles.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.RolesCheck, null, { timeout: 15000 });

    const preloaded = await page.evaluate(() => window.RolesCheck.preloadAll());
    assert.deepEqual(preloaded, [true, true, true, true], '四个皮肤应全部预载成功');

    const skinIds = ['box'].concat(await page.evaluate(() => window.RolesCheck.skinIds()));
    const shots = {};
    for (const id of skinIds) {
      const info = await page.evaluate((sid) => window.RolesCheck.render(sid, null), id);
      assert.equal(info.ok, true, id + ' create 失败: ' + (info.reason || ''));
      if (id !== 'box') {
        assert.ok(info.skinnedMeshes >= 1, id + ' 应包含蒙皮网格');
      }
      assert.ok(info.hasWeapon && info.hasMarker, id + ' 缺 Weapon/TeamMarker');
      const file = path.join(outDir, id + '.png');
      await page.locator('#stage').screenshot({ path: file });
      shots[id] = fs.readFileSync(file);
      // 阈值 10000 的说明：swiftshader 软渲染下真实角色截图约 14KB，纯空白 PNG 只有
      // 2-5KB——10000 足以抓空白画面。真正防"换皮失败"的是后面的两两不同断言。
      assert.ok(shots[id].length > 10000, id + ' 截图疑似空白画面');

      // 移动驱动：截图应与待机不同（动画在推进）
      await page.evaluate((sid) => window.RolesCheck.render(sid, { moving: true, speedRatio: 1, onGround: true }), id);
      const moveFile = path.join(outDir, id + '_run.png');
      await page.locator('#stage').screenshot({ path: moveFile });
      assert.ok(Buffer.compare(shots[id], fs.readFileSync(moveFile)) !== 0, id + ' 移动驱动无画面变化');
    }

    // 五张待机图两两不同
    for (let i = 0; i < skinIds.length; i++) {
      for (let j = i + 1; j < skinIds.length; j++) {
        assert.ok(
          Buffer.compare(shots[skinIds[i]], shots[skinIds[j]]) !== 0,
          skinIds[i] + ' 与 ' + skinIds[j] + ' 截图相同，模型没有切换'
        );
      }
    }
    assert.deepEqual(errors, [], '页面不应有 pageerror');
    console.log('check-roles OK：' + skinIds.length + ' 个角色截图已写入 tmp/roles-check/');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error('check-roles FAIL:', e.message);
  process.exit(1);
});
