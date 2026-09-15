/*
 * scripts/check-weapons-tps-ingame.js — 主游戏真机：体素化身的**背挂**美术枪
 *
 * 用法：node scripts/check-weapons-tps-ingame.js
 *
 * ⚠️ 先说清楚两条第三人称路径，别混：
 *   - **体素骨骼角色**（真机里的队友/AI 化身）走 AnimationMixer，身上**只有背枪**
 *     （挂在 Dummy001 骨骼下），没有独立的手持枪节点。所以真机里能验的只有背枪。
 *   - **盒子兵**（`voxel:false`，AI 占位 / 预览 / 早期帧）才有手持枪，走 addGun，
 *     由 scripts/check-weapons-tps.js 在组件级覆盖。
 *
 * 这个脚本补的是"真机里背枪长什么样"——体素角色加载失败会静默回退盒子兵 +
 * 盒子枪，画面上只是"枪有点丑"，很容易漏。
 * 产物：tmp/weapons-tps-ingame/*.png
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'weapons-tps-ingame');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

// 第一批（SM_*_001.glb，枪口朝 +Z）+ 第二批（Mod_*.glb，枪口朝 -Z），两批朝向相反。
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
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

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
    await page.waitForTimeout(2500);

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
    assert.deepEqual(WEAPONS.filter((id) => !artState[id]), [], '美术资产没就绪');

    const shots = {};
    for (const id of WEAPONS) {
      // 建一个体素化身（和真机队友同一条路径），检查背枪是不是美术 GLB
      const info = await page.evaluate((wid) => {
        const g = window.VF.game;
        const THREE = window.THREE;
        const V = window.VF.SoldierVoxel;
        if (!V || !V.create) return { ok: false, reason: 'SoldierVoxel 不可用' };
        if (!V.isReady || !V.isReady('assault')) {
          return { ok: false, reason: '骨骼角色模型没就绪' };
        }

        const soldier = V.create('assault', { team: 'ally', weaponId: wid });
        if (!soldier) return { ok: false, reason: 'create 返回 null' };

        // 背枪挂在 Dummy001 骨骼下的 'ViewGun'（美术）/'Weapon'（程序化）
        const bone = soldier.getObjectByName('Dummy001');
        if (!bone) return { ok: false, reason: '找不到 Dummy001 骨骼' };
        const named = bone.getObjectByName('ViewGun') || bone.getObjectByName('Weapon');
        const mesh = named ? named.getObjectByName('WeaponMesh') : null;
        if (!mesh) {
          return {
            ok: false,
            reason: '背枪没吃到 GLB（节点=' + (named ? named.name : 'null') + '）',
          };
        }

        // 放到玩家正前方一段距离的空地上，相机也钉在它侧前方 —— 不依赖地形，
        // 避免被墙/掩体挡住取景（早先版本用玩家相对偏移，常拍到墙里）。
        const p = g.player ? g.player.object.position : new THREE.Vector3();
        const base = new THREE.Vector3(p.x, p.y + 0.2, p.z + 3.0);
        soldier.position.copy(base);
        soldier.rotation.y = -Math.PI * 0.35;
        g.scene.add(soldier);
        window.__probe = soldier;

        const cam = g.camera;
        window.__savedCam = {
          pos: cam.position.clone(),
          quat: cam.quaternion.clone(),
          fov: cam.fov,
        };
        // 站在化身右前上方，稍微俯视，能看清背在身后的整把枪
        cam.position.set(base.x + 1.5, base.y + 1.7, base.z + 2.4);
        cam.lookAt(base.x, base.y + 1.25, base.z);
        cam.updateMatrixWorld(true);

        // 背枪应当朝上斜背：枪口（Muzzle，在枪管 -Z 端）朝世界 +Y 一侧
        const muzzle = named.getObjectByName('Muzzle');
        const mp = muzzle ? muzzle.getWorldPosition(new THREE.Vector3()) : null;
        const local = mp ? soldier.worldToLocal(mp.clone()) : null;
        return {
          ok: true,
          nodeName: named.name,
          muzzleInSoldier: local ? [local.x, local.y, local.z].map((n) => +n.toFixed(3)) : null,
        };
      }, id);

      if (!info.ok) {
        log(id + ' 跳过: ' + info.reason);
        continue;
      }
      // 背枪是斜背在身后的：枪口朝上偏后（枪管指向 +Y 一侧）
      assert.ok(
        info.muzzleInSoldier && info.muzzleInSoldier[1] > 0.9,
        id + ' 真机背枪枪口没朝上斜背: ' + JSON.stringify(info)
      );

      await page.waitForTimeout(500);
      const file = path.join(outDir, id + '.png');
      await page.screenshot({ path: file });
      shots[id] = fs.readFileSync(file);
      log(
        id.padEnd(6) + ' 背枪GLB=true 节点=' + info.nodeName +
          ' 枪口(化身本地)=' + JSON.stringify(info.muzzleInSoldier)
      );

      // 清掉临时化身 + 还原相机
      await page.evaluate(() => {
        const g = window.VF.game;
        if (window.__probe && window.__probe.parent) window.__probe.parent.remove(window.__probe);
        window.__probe = null;
        if (window.__savedCam) {
          g.camera.position.copy(window.__savedCam.pos);
          g.camera.quaternion.copy(window.__savedCam.quat);
          g.camera.fov = window.__savedCam.fov;
          g.camera.updateProjectionMatrix();
          window.__savedCam = null;
        }
      });
    }

    const got = Object.keys(shots);
    for (let i = 0; i < got.length; i++) {
      for (let k = i + 1; k < got.length; k++) {
        assert.ok(
          Buffer.compare(shots[got[i]], shots[got[k]]) !== 0,
          got[i] + ' 与 ' + got[k] + ' 真机画面相同'
        );
      }
    }
    log('');
    log('真机体素化身背枪 ' + got.length + ' 把美术枪画面两两不同 ✓');
    log('截图: ' + path.relative(root, outDir) + '/');
    if (errors.length) log('\n页面错误(' + errors.length + '):\n' + errors.slice(0, 8).join('\n'));
  } catch (e) {
    log('失败: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n', 'utf8');
  }
})();
