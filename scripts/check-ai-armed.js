/*
 * scripts/check-ai-armed.js — AI 骨骼角色「默认持枪 + 持枪跑」验证
 *
 * 用法：
 *   node scripts/check-ai-armed.js          渲染持枪 / 持枪跑 / 正面三个视角
 *   node scripts/check-ai-armed.js --probe   只打印挂点与姿势（调挂枪参数时用）
 *
 * 断言：
 *   1. armed 角色右手挂点（Dummy001_R-Hand）下必须有 GLB 枪（WeaponMesh）
 *   2. 枪口（Muzzle）在角色本地空间必须落在**身体前方**（z < 0，角色朝 -Z）
 *   3. armed 角色不再挂背枪（Dummy001 下不应有枪）
 *   4. 持枪跑时当前 clip 必须是 RifleRun
 *
 * 产物：tmp/ai-armed/*.png + summary.txt
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'ai-armed');
const probeOnly = process.argv.indexOf('--probe') >= 0;
const gunOnly = process.argv.indexOf('--gun') >= 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wav': 'audio/wav',
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

// 每批挑代表：长枪 / 短枪 / 手枪，覆盖两种朝向约定与不同 scale
const WEAPONS = ['m4a1', 'm249', 'usp', 'mp5'];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, port } = await serve();
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 520 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${port}/scripts/check-ai-armed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    const boot = await page.evaluate(() => window.__boot);
    log('引导: ' + JSON.stringify(boot));
    assert.ok(boot.hasWM, 'VF.WeaponModels 未注册');
    assert.ok(boot.hasVoxel, 'VF.SoldierVoxel 未注册');
    assert.ok(boot.voxelReady, '骨骼角色模型没加载完');

    if (probeOnly) {
      const probe = await page.evaluate(() => window.AIArmed.probe());
      log('挂点/姿势: ' + JSON.stringify(probe, null, 2));
    } else if (gunOnly) {
      for (const id of WEAPONS) {
        const g = await page.evaluate((wid) => window.AIArmed.probeGun(wid), id);
        log('== ' + id);
        (g.rows || []).forEach((r) => {
          log(
            '   ' + r.clip.padEnd(9) + ' t=' + r.t +
              ' 枪口方向=' + JSON.stringify(r.dir) +
              ' 枪口位置=' + JSON.stringify(r.muzzle)
          );
        });
        if (g.error) log('   ' + g.error);
      }
    } else {
      await page.evaluate(() => window.VF.WeaponModels.preloadAll());

      const shots = {};
      for (const id of WEAPONS) {
        const info = await page.evaluate((wid) => window.AIArmed.render(wid, { t: 0.4 }), id);
        log(id.padEnd(6) + ' ' + JSON.stringify(info));

        assert.ok(info.armed && info.armed.length, id + ' 没建出 armed 角色');
        info.armed.forEach((a, i) => {
          assert.ok(a.hand, id + ' #' + i + ' 找不到右手挂点 Dummy001_R-Hand');
          assert.ok(a.hasMesh, id + ' #' + i + ' 手持枪没吃到 GLB: ' + JSON.stringify(a));
          assert.equal(
            a.back,
            false,
            id + ' #' + i + ' armed 角色还在挂背枪（应只持枪）'
          );
        });
        assert.ok(
          info.muzzle && info.muzzle.root && info.muzzle.root[2] < -0.2,
          id + ' 枪口没朝身体前方（root 空间 z 应为负）: ' + JSON.stringify(info.muzzle)
        );
        assert.ok(
          info.muzzle.root[1] > 0.5 && info.muzzle.root[1] < 1.8,
          id + ' 枪口高度不合理（应在胸/肩之间）: ' + JSON.stringify(info.muzzle.root)
        );

        await page.waitForTimeout(200);
        const file = path.join(outDir, id + '.png');
        await page.screenshot({ path: file });
        shots[id] = fs.readFileSync(file);
        assert.ok(shots[id].length > 15000, id + ' 截图疑似空白（' + shots[id].length + ' 字节）');
      }

      for (let i = 0; i < WEAPONS.length; i++) {
        for (let k = i + 1; k < WEAPONS.length; k++) {
          assert.ok(
            Buffer.compare(shots[WEAPONS[i]], shots[WEAPONS[k]]) !== 0,
            WEAPONS[i] + ' 与 ' + WEAPONS[k] + ' 渲染相同'
          );
        }
      }

      // 持枪跑：驱动后当前 clip 必须是 RifleRun
      const clip = await page.evaluate(() => {
        const V = window.VF.SoldierVoxel;
        const r = V.create('assault', { team: 'ally', weaponId: 'm4a1', armed: true });
        for (let i = 0; i < 60; i++) {
          V.driveArmed
            ? V.driveArmed(r, 0.016, { moving: true, speedRatio: 1, onGround: true })
            : V.drive(r, 0.016, { moving: true, speedRatio: 1, onGround: true });
        }
        const cur = r.userData.glbAnim.current;
        return cur ? cur.getClip().name : null;
      });
      log('持枪跑当前 clip: ' + clip);
      assert.equal(clip, 'RifleRun', '移动时应播 RifleRun，实际: ' + clip);

      log('');
      log('AI 持枪 + 持枪跑 ✓');
      log('截图: ' + path.relative(root, outDir) + '/');
    }
    if (errors.length) log('\n页面错误(' + errors.length + '):\n' + errors.slice(0, 10).join('\n'));
  } catch (e) {
    log('失败: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n', 'utf8');
  }
})();
