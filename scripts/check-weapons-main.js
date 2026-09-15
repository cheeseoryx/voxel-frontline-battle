/*
 * scripts/check-weapons-main.js — 美术枪械在**主游戏**（根 index.html）里的验证
 *
 * 用法：node scripts/check-weapons-main.js
 *
 * 和 check-weapons-e2e.js 的区别：那个是组件级（直接调 createViewModel）。
 * 这个走完整主游戏：根首页 → 进入枢纽 → 单人 → 选兵种 → 跳过小队介绍 →
 * 等 game.running，然后用 game.weapons.equip(id) 切枪，检查相机下的 viewmodel
 * 真的换成了 GLB（不是程序化盒子），再截图。
 *
 * 和 check-weapons-ingame.js 的区别：那个跑 modes/small-battle，而 small-battle
 * 用的是 modes/small-battle/js/ 下的**平行分叉副本**（soldier.js / player.js /
 * weapons.js 全都另有一份，且 Economy.ownsWeapon 会按购买记录拦截）。主游戏
 * 才是 启动游戏.cmd 指向的入口，所以两边要分开验证。
 *
 * 产物：tmp/weapons-main/*.png + summary.txt
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'weapons-main');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
  '.vox': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
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

// 第一批 SM_*_001.glb（枪口朝 +Z）+ 第二批 Mod_*.glb（枪口朝 -Z）。
// 两批朝向相反，所以这个列表必须两批都覆盖，否则只测一半朝向。
const WEAPONS = [
  'm249', 'mp5', 'mp7', 'p90', 'usp',
  'acr', 'ak74', 'hk419', 'm4a1', 'mk14ebr', 'scarh',
];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, port } = await serve();
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    page.on('pageerror', (e) => errors.push(e.message));
    const consoleLogs = [];
    page.on('console', (m) => {
      const t = m.text();
      consoleLogs.push('[' + m.type() + '] ' + t);
      if (m.type() === 'error') errors.push('[console] ' + t);
    });
    const netFails = [];
    page.on('requestfailed', (r) => netFails.push(r.url() + '  ' + (r.failure() && r.failure().errorText)));
    page.on('response', (r) => {
      if (r.status() >= 400) netFails.push('HTTP ' + r.status() + ' ' + r.url());
    });
    // 已知缺失资源（和 check-frontline-browser.cjs 同一份白名单）：
    // 主题曲没进仓库，属于既有状态，不该算到这次改动头上。
    const KNOWN_MISSING = [/\/assets\/music\/theme\.mp3$/];
    const unexpectedNet = () => netFails.filter((s) => !KNOWN_MISSING.some((re) => re.test(s)));

    // 主游戏启动链（照抄 scripts/check-frontline-browser.cjs 的 large 流程）
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#enter-hub-btn:not([disabled])', { timeout: 60000 });
    await page.click('#enter-hub-btn');
    await page.waitForSelector('#mode-overlay:not(.hidden)', { timeout: 60000 });
    await page.click('[data-mode-action=solo]');
    await page.waitForSelector('#class-overlay:not(.hidden)', { timeout: 60000 });
    await page.click('#class-confirm-btn');
    await page.waitForSelector('#squad-intro-overlay:not(.hidden)', { timeout: 60000 });
    await page.click('#squad-intro-skip');
    await page.waitForFunction(() => window.VF && window.VF.game && window.VF.game.running, null, {
      timeout: 60000,
    });
    await page.waitForTimeout(2500); // 让首帧、光照、后处理稳定

    const probe = await page.evaluate(() => ({
      hasWM: !!(window.VF && window.VF.WeaponModels),
      hasWeapons: !!(window.VF && window.VF.game && window.VF.game.weapons),
      running: !!(window.VF && window.VF.game && window.VF.game.running),
      weaponIdKeys: Object.keys((window.VF && window.VF.WEAPONS) || {}),
    }));
    log('环境探测: running=' + probe.running + ' WeaponModels=' + probe.hasWM +
      ' 武器表(' + probe.weaponIdKeys.length + ')=' + probe.weaponIdKeys.join(','));
    assert.ok(probe.hasWM, 'VF.WeaponModels 未注册');
    assert.ok(probe.hasWeapons, 'game.weapons 不存在');

    await page.evaluate(() => window.VF.WeaponModels.preloadAll());
    const artState = await page.evaluate((ids) => {
      const W = window.VF.WeaponModels;
      const out = {};
      ids.forEach((id) => {
        out[id] = W.has(id);
      });
      return out;
    }, WEAPONS);
    log('美术枪械就绪: ' + JSON.stringify(artState));
    const missing = WEAPONS.filter((id) => !artState[id]);
    if (missing.length) {
      log('网络失败:');
      unexpectedNet().slice(0, 20).forEach((s) => log('  ' + s));
      log('相关控制台:');
      consoleLogs.filter((s) => /weapon|glb|gltf/i.test(s)).slice(0, 20).forEach((s) => log('  ' + s));
    }
    assert.deepEqual(missing, [], '这些枪的美术资产没就绪: ' + missing.join(', '));

    const shots = {};
    for (const id of WEAPONS) {
      const info = await page.evaluate((wid) => {
        const g = window.VF.game;
        const W = window.VF.WeaponModels;
        const before = { current: g.weapons.current, inTable: !!(window.VF.WEAPONS || {})[wid] };
        g.weapons.equip(wid);
        const p = g.player;
        const gun = p && p.gunNode;
        const mesh = gun ? gun.getObjectByName('WeaponMesh') : null;
        return {
          before: before,
          meshFound: !!mesh,
          hasMap: !!(mesh && mesh.material && mesh.material.map),
          current: g.weapons.current,
          muzzleZ: p && p.muzzle ? Number(p.muzzle.getWorldPosition(new window.THREE.Vector3()).z.toFixed(3)) : null,
          gunNodeChildren: gun ? gun.children.map((c) => c.name) : [],
        };
      }, id);

      assert.equal(info.before.inTable, true, id + ' 不在 VF.WEAPONS 里（weapon-catalog 没合并？）');
      assert.equal(info.meshFound, true, id + ' 第一人称没吃到 GLB。' + JSON.stringify(info));
      assert.equal(info.current, id, id + ' 切枪没生效（current=' + info.current + '）');
      assert.equal(info.hasMap, true, id + ' 贴图没接上');

      await page.waitForTimeout(700);
      const file = path.join(outDir, id + '.png');
      await page.screenshot({ path: file });
      shots[id] = fs.readFileSync(file);
      assert.ok(shots[id].length > 30000, id + ' 截图疑似空白（' + shots[id].length + ' 字节）');
      log(id.padEnd(6) + ' 当前=' + info.current + ' 枪体=WeaponMesh 贴图=' + info.hasMap +
        ' 枪口世界Z=' + info.muzzleZ);
    }

    for (let i = 0; i < WEAPONS.length; i++) {
      for (let k = i + 1; k < WEAPONS.length; k++) {
        assert.ok(
          Buffer.compare(shots[WEAPONS[i]], shots[WEAPONS[k]]) !== 0,
          WEAPONS[i] + ' 与 ' + WEAPONS[k] + ' 真机画面相同'
        );
      }
    }
    log('');
    log('主游戏' + WEAPONS.length + '把枪画面两两不同 ✓');
    log('截图: ' + path.relative(root, outDir) + '/');
    // netFails 里除了白名单，不该有别的失败资源
    const badNet = unexpectedNet();
    if (badNet.length) log('\n非预期资源失败(' + badNet.length + '):\n' + badNet.slice(0, 10).join('\n'));
    assert.deepEqual(badNet, [], '有非预期的缺失/失败资源（见上面日志）');
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
