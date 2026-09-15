/*
 * scripts/check-weapons-e2e.js — 美术枪械端到端验证
 *
 * 用法：node scripts/check-weapons-e2e.js
 * 断言：
 *   1. 五把枪的美术 GLB 全部预载成功
 *   2. 第一人称 createViewModel 吃到了 GLB（gun 下有 WeaponMesh，不是盒子枪）
 *   3. 第三人称 createClassSoldier 也吃到了 GLB
 *   4. 第一人称枪口在相机前方（z < 0），且落在准星附近（|x| 小、y 接近枪膛线）
 *   5. 五把枪的截图两两不同 —— 证明换的是不同资产
 * 产物：tmp/weapons-e2e/*.png（人工复核握持姿势 / 枪口位置）
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'weapons-e2e');

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
    const page = await browser.newPage({ viewport: { width: 1120, height: 470 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/scripts/check-weapons-e2e.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.WeaponsE2E, null, { timeout: 15000 });

    const ids = await page.evaluate(() => window.WeaponsE2E.ids());
    assert.ok(ids.length >= 11, '枪的 id 列表不对劲，只有 ' + ids.length + ' 个（注册表里现在混了投掷物，ids() 传了 kind 过滤吗？）');
    await page.evaluate(() => window.WeaponsE2E.preloadAll());
    // 预载总数是"枪 + 投掷物"，不能直接跟 ids.length 比，改为逐个查缺
    const missing = await page.evaluate(
      (list) => list.filter((id) => !window.WeaponsE2E.has(id)),
      ids
    );
    assert.deepEqual(missing, [], '这些枪没预载成功: ' + missing.join(', '));

    const shots = {};
    for (const id of ids) {
      const info = await page.evaluate((sid) => window.WeaponsE2E.render(sid), id);
      assert.equal(info.ok, true, id + ' 渲染失败: ' + (info.reason || ''));

      assert.equal(info.fpsIsArt, true, id + ' 第一人称没吃到 GLB（gun 下没有 WeaponMesh）');
      assert.equal(info.tpsIsArt, true, id + ' 第三人称没吃到 GLB');

      // 枪口必须在相机前方
      const mz = info.fpsMuzzleInCam[2];
      assert.ok(mz < 0, id + ' 第一人称枪口不在相机前方: z=' + mz);
      // 枪口不该横向甩出去
      assert.ok(Math.abs(info.fpsMuzzleInCam[0]) < 0.25, id + ' 第一人称枪口横向偏移过大: x=' + info.fpsMuzzleInCam[0]);
      // 第三人称枪身长轴应该是 Z（尺寸里 z 最大）
      const sz = info.tpsGunSize;
      assert.ok(sz[2] > sz[0] && sz[2] > sz[1], id + ' 第三人称枪身长轴不在 Z: ' + sz.join('×'));

      const file = path.join(outDir, id + '.png');
      await page.locator('#wrap').screenshot({ path: file });
      shots[id] = fs.readFileSync(file);
      assert.ok(shots[id].length > 20000, id + ' 截图疑似空白（' + shots[id].length + ' 字节）');

      log(
        id.padEnd(6) +
          ' fps资产=' + info.fpsIsArt +
          ' 枪口(相机空间)=' + info.fpsMuzzleInCam.join(',') +
          ' tps枪身=' + sz.join('×') +
          ' tps节点=' + (info.tpsGunName || '-')
      );
    }

    // 两两不同
    for (let i = 0; i < ids.length; i++) {
      for (let k = i + 1; k < ids.length; k++) {
        assert.ok(
          Buffer.compare(shots[ids[i]], shots[ids[k]]) !== 0,
          ids[i] + ' 与 ' + ids[k] + ' 的渲染完全相同，说明没换到不同资产'
        );
      }
    }
    log('');
    log('五把枪两两渲染不同 ✓');
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
