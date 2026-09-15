/*
 * scripts/check-weapons-tps.js — 美术枪械在**主游戏**里的第三/背枪消费点验证
 *
 * 用法：node scripts/check-weapons-tps.js
 *
 * 第一人称由 check-weapons-main.js 负责（走真机 equip + 截图）。
 * 这个脚本专盯另外两个消费点——它们在组件级就能干净地验，不用等真机：
 *   1. 第三人称 / AI 手持：VF.Soldier.createClassSoldier(cls, { weaponId })
 *      的 'Weapon' 节点下应当是 GLB（真枪尺寸 × scale），而不是盒子枪。
 *   2. 背部挂枪：VF.SoldierVoxel.create(id, { weaponId }) 的 Dummy001 骨骼下
 *      应当挂 GLB 而不是盒子枪。
 *
 * 这两条以前是**静默回退**的——参数没透传就会悄悄用程序化枪，画面上只是
 * "枪有点丑"，很难看出来。所以这里用断言钉死。
 *
 * 产物：tmp/weapons-tps/*.png + summary.txt
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'weapons-tps');

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
    args: ['--enable-unsafe-swiftshader'],
  });
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 480 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${port}/scripts/check-weapons-tps.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    const boot = await page.evaluate(() => window.__boot);
    log('引导: ' + JSON.stringify(boot));
    assert.ok(boot.hasWM, 'VF.WeaponModels 未注册');
    assert.ok(boot.hasSoldier, 'VF.Soldier 未注册');
    assert.ok(boot.hasVoxel, 'VF.SoldierVoxel 未注册');
    assert.ok(boot.voxelReady, '骨骼角色模型没加载完（背枪那条测不了）');

    await page.evaluate(() => window.VF.WeaponModels.preloadAll());

    const results = await page.evaluate((ids) => {
      const THREE = window.THREE;
      const out = {};
      ids.forEach((id) => {
        try {
        const rec = { artReady: window.VF.WeaponModels.has(id) };

        // --- 消费点 1：第三人称 / AI 手持 ---
        // 注意：assault 走 buildVanguard → addGun(root,'rifle',...)，
        // 而且美术枪走的是 buildGunProp 的 art 分支 —— 那个 gun.name 是
        // 'ViewGun'（weapon-models.js 里写死的），**不是**程序化那条的 'Weapon'。
        // 所以两个名字都要找。'juggernaut' 是刻意保持程序化的（AI 重装兵），
        // 这里只验 assault。
        const soldier = window.VF.Soldier.createClassSoldier('assault', {
          weaponId: id,
          voxel: false,
        });
        // ⚠️ 体素角色的**背枪**也叫 'ViewGun' 且挂在 Dummy001 骨骼下，
        // getObjectByName 会先命中它。手持枪的父节点是 SoldierFacing，必须按父节点筛，
        // 否则量到的是背在身后的那把（断言会误判成"枪口朝后"）。
        const wrap = soldier.getObjectByName('SoldierFacing');
        const named = wrap && wrap.getObjectByName('ViewGun');
        const held = named && named.parent === wrap ? named : null;
        rec.soldierName = soldier ? soldier.name : null;
        rec.heldName = held ? held.name : null;
        rec.heldHasMesh = !!(held && held.getObjectByName('WeaponMesh'));
        rec.heldChildren = held ? held.children.map((c) => c.name) : [];
        if (held) {
          const b = new THREE.Box3().setFromObject(held);
          const s = new THREE.Vector3();
          b.getSize(s);
          rec.heldSize = [s.x, s.y, s.z].map((n) => Number(n.toFixed(3)));
          // 真正该看的是**枪口**在 root 空间的位置：角色朝向 -Z，所以枪口
          // 必须落在身体前方（z 明显为负）才会"指向敌人"。
          // 枪体中心 z 靠后是正常的——原点在握把，枪从握把往前伸。
          const muzzle = held.getObjectByName('Muzzle');
          if (muzzle) {
            const wp = muzzle.getWorldPosition(new THREE.Vector3());
            const mp = soldier.worldToLocal(wp.clone());
            rec.muzzleInRoot = [mp.x, mp.y, mp.z].map((n) => Number(n.toFixed(3)));
          }
        }

        // --- 消费点 2：背部挂枪 ---
        // SoldierVoxel.create 需要骨骼模型就绪，否则返回 null（静默回退盒子兵）。
        // _mountBackWeapon 同样优先用 buildProp，节点名一样是 'ViewGun'。
        const voxel = window.VF.SoldierVoxel && window.VF.SoldierVoxel.create
          ? window.VF.SoldierVoxel.create('assault', { team: 'ally', weaponId: id })
          : null;
        rec.voxelCreated = !!voxel;
        let back = null;
        if (voxel) {
          const bone = voxel.getObjectByName('Dummy001');
          if (bone) back = bone.getObjectByName('ViewGun') || bone.getObjectByName('Weapon');
        }
        rec.backFound = !!back;
        rec.backName = back ? back.name : null;
        rec.backHasMesh = !!(back && back.getObjectByName('WeaponMesh'));
        rec.backChildren = back ? back.children.map((c) => c.name) : [];

          out[id] = rec;
        } catch (e) {
          out[id] = { artReady: false, error: String((e && e.stack) || e) };
        }
      });
      return out;
    }, WEAPONS);
    log('逐把探测: ' + JSON.stringify(results));

    const shots = {};
    for (const id of WEAPONS) {
      const r = results[id];
      log(
        id.padEnd(6) +
          ' 资产=' + r.artReady +
          ' | 手持GLB=' + r.heldHasMesh + ' 节点=' + r.heldName +
          ' 枪口(root)=' + JSON.stringify(r.muzzleInRoot) +
          ' 尺寸=' + JSON.stringify(r.heldSize) +
          ' | 背枪GLB=' + r.backHasMesh + ' 节点=' + r.backName
      );
      if (!r.heldHasMesh) log('   手持子节点: ' + (r.heldChildren || []).join(', '));
      if (!r.backHasMesh) log('   背枪子节点: ' + (r.backChildren || []).join(', '));

      assert.equal(r.artReady, true, id + ' 美术资产没就绪');
      assert.equal(r.heldHasMesh, true, id + ' 第三人称手持没吃到 GLB。' + JSON.stringify(r));
      assert.equal(r.backFound, true, id + ' 背枪找不到枪节点');
      assert.equal(r.backHasMesh, true, id + ' 背枪没吃到 GLB。' + JSON.stringify(r));
      // 枪口必须在身体前方（角色朝 -Z）。finishSoldier 的镜像补偿没生效时，
      // 枪会整根翻到背后，这个 z 会变成正数。
      assert.ok(
        r.muzzleInRoot && r.muzzleInRoot[2] < -0.5,
        id + ' 第三人称枪口没朝前（应在身体前方 z<-0.5）: ' + JSON.stringify(r.muzzleInRoot)
      );
      // 第三人称要吃 scale，长枪总长应明显长于真枪（M249 真枪 1.08m，×1.0 后
      // 斜置包围盒约 1.2m）；短枪按各自系数放大后也都过 1m。
      assert.ok(
        r.heldSize[2] > 1.0,
        id + ' 第三人称枪身 Z 向过短（没吃到缩放？）: ' + r.heldSize[2]
      );

      await page.evaluate((wid) => window.WeaponsTPS.render(wid), id);
      await page.waitForTimeout(300);
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
    log('');
    log('第三人称 + 背枪两个消费点全部吃到 GLB ✓');
    log('截图: ' + path.relative(root, outDir) + '/');
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
