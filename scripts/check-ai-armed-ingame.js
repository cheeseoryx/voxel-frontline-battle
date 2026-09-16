/*
 * scripts/check-ai-armed-ingame.js — AI 持枪在主游戏真机里的验证
 *
 * 用法：node scripts/check-ai-armed-ingame.js
 *
 * 组件级验证在 check-ai-armed.js（不启动游戏，直接建角色看挂点/朝向）。
 * 这个走完整主游戏：首页 → 枢纽 → 单人 → 选兵种 → 跳过小队介绍 → 等 AI
 * 刷出来，然后
 *   1. 断言场上骨骼角色 AI 全部 opts.armed（右手有枪、背上无枪、枪口朝前）
 *   2. 把几个 AI 摆到玩家正前方并让它们朝玩家跑，截两张 FPS 视角的图，
 *      肉眼确认是"端着枪跑"而不是空手跑
 *
 * 产物：tmp/ai-armed-ingame/*.png + summary.txt
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'ai-armed-ingame');

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
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('[console] ' + m.text());
    });

    // 主游戏启动链（与 check-weapons-main.js 保持一致）
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

    // 等 AI 刷出来（armiesSpawned 之后才有单位）
    await page.waitForFunction(
      () => {
        const ai = window.VF.game.ai;
        return ai && ((ai.red && ai.red.length) || (ai.blue && ai.blue.length));
      },
      null,
      { timeout: 60000 }
    );
    await page.waitForTimeout(3000);

    const boot = await page.evaluate(() => {
      const V = window.VF.SoldierVoxel;
      return {
        voxelReady: !!(V && V.isReady && V.isReady('assault')),
        hasDriveArmed: !!(V && V.driveArmed),
        hasWM: !!(window.VF && window.VF.WeaponModels),
      };
    });
    log('环境: ' + JSON.stringify(boot));
    assert.ok(boot.hasWM, 'VF.WeaponModels 未注册');
    assert.ok(boot.hasDriveArmed, 'SoldierVoxel.driveArmed 不存在（soldier-voxel.js 没改到位？）');
    assert.ok(boot.voxelReady, '骨骼角色模型没就绪，AI 会全是盒子兵');

    await page.evaluate(() => window.VF.WeaponModels.preloadAll());

    const audit = await page.evaluate(() => {
      const ai = window.VF.game.ai;
      const all = [].concat(ai.blue || [], ai.red || []);
      const out = {
        total: all.length,
        voxel: 0,
        armedFlag: 0,
        handGun: 0,
        backGun: 0,
        boxSoldier: 0,
        weaponIds: {},
        problems: [],
      };
      all.forEach((u, i) => {
        const m = u.mesh;
        if (!m) return;
        const isVoxel = !!(m.userData && m.userData.glbAnim);
        if (!isVoxel) {
          out.boxSoldier++;
          return;
        }
        out.voxel++;
        if (m.userData.armed) out.armedFlag++;
        const hand = m.getObjectByName('Dummy001_R-Hand');
        const gun = hand && (hand.getObjectByName('ViewGun') || hand.getObjectByName('Weapon'));
        const hasMesh = !!(gun && gun.getObjectByName('WeaponMesh'));
        if (hasMesh) out.handGun++;
        const backBone = m.getObjectByName('Dummy001');
        const backGun = backBone && (backBone.getObjectByName('ViewGun') || backBone.getObjectByName('Weapon'));
        if (backGun) out.backGun++;
        // 枪口方向：角色本地 -Z 才算朝前（角色朝向是 mesh.rotation.y）
        let muzzleZ = null;
        if (gun) {
          const mp = gun.getObjectByName('Muzzle');
          if (mp) {
            const wp = mp.getWorldPosition(new window.THREE.Vector3());
            const mq = new window.THREE.Quaternion();
            m.getWorldQuaternion(mq);
            wp.sub(m.getWorldPosition(new window.THREE.Vector3())).applyQuaternion(mq.invert());
            muzzleZ = Number(wp.z.toFixed(2));
            if (muzzleZ > -0.2) out.problems.push('#' + i + ' 枪口朝后 z=' + muzzleZ);
          }
        }
        if (!isVoxel) return;
        if (!m.userData.armed) out.problems.push('#' + i + ' 没带 armed 标记');
        if (!hasMesh) out.problems.push('#' + i + ' 右手没枪');
        if (backGun) out.problems.push('#' + i + ' 还挂着背枪');
      });
      // 顺便记一下 AI 手上的武器型号（按 type 分组）
      all.forEach((u) => {
        if (!u.mesh) return;
        const hand = u.mesh.getObjectByName && u.mesh.getObjectByName('Dummy001_R-Hand');
        const gun = hand && (hand.getObjectByName('ViewGun') || hand.getObjectByName('Weapon'));
        if (!gun) return;
        const key = (u.team || '?') + '/' + (u.type || '?');
        out.weaponIds[key] = (out.weaponIds[key] || 0) + 1;
      });
      return out;
    });
    log('场上单位审计: ' + JSON.stringify(audit));
    assert.ok(audit.voxel > 0, '场上一具骨骼角色都没有（AI 全回落成了盒子兵）');
    assert.equal(audit.armedFlag, audit.voxel, '有骨骼角色没带 armed 标记');
    assert.equal(audit.handGun, audit.voxel, '有骨骼角色的右手没枪');
    assert.equal(audit.backGun, 0, 'AI 还挂着背枪（armed 应当只持枪）');
    assert.deepEqual(audit.problems, [], '枪口朝向异常');

    // 摆到玩家正前方，让它们朝玩家跑
    const placed = await page.evaluate(() => {
      const THREE = window.THREE;
      const g = window.VF.game;
      const cam = g.camera;
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      dir.y = 0;
      dir.normalize();
      const eye = cam.getWorldPosition(new THREE.Vector3());
      const right = new THREE.Vector3(-dir.z, 0, dir.x);
      // 临时关掉威胁感知：AI 一发现玩家就切 engage 停下瞄准（那是 AimIdle，
      // 属于另一条路径）。本次要验的是"移动播持枪跑"，所以让它们纯巡逻。
      // 只在页面里覆盖，不改源文件。
      const proto = Object.getPrototypeOf(g.ai);
      if (!proto.__armedCheckPatched) {
        proto._nearestHostile = function () { return null; };
        proto.__armedCheckPatched = true;
      }
      const list = [].concat(g.ai.blue || [], g.ai.red || [])
        .filter((u) => u.alive && u.mesh && u.mesh.userData && u.mesh.userData.armed);
      const picked = list.slice(0, 3);
      picked.forEach((u, i) => {
        const dist = 9 + i * 1.8;
        const side = (i - 1) * 1.7;
        const p = eye.clone().add(dir.clone().multiplyScalar(dist)).add(right.clone().multiplyScalar(side));
        u.mesh.position.set(p.x, u.mesh.position.y, p.z);
        u.state = 'patrol';
        u.patrolTarget = eye.clone(); // 朝玩家跑
        u.patrolWalk = 8;
        u.patrolWait = 0;
        u.patrolBudget = 8;
        window.__aiPicked = window.__aiPicked || [];
        window.__aiPicked.push(u);
      });
      return picked.length;
    });
    log('摆到正前方的 AI: ' + placed);
    assert.ok(placed > 0, '没有可摆位的 AI');

    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(outDir, 'approach-0.png') });
    await page.waitForTimeout(1100);
    await page.screenshot({ path: path.join(outDir, 'approach-1.png') });
    await page.waitForTimeout(1100);
    await page.screenshot({ path: path.join(outDir, 'approach-2.png') });

    // 跑动中当前 clip 应是 RifleRun（AI 单位的 locomotion 由 updateLocomotion 委托）
    const movingClips = await page.evaluate(() => {
      const out = [];
      (window.__aiPicked || []).forEach((u) => {
        const a = u.mesh && u.mesh.userData && u.mesh.userData.glbAnim;
        out.push({
          clip: a && a.current ? a.current.getClip().name : null,
          state: u.state,
          dist: Number(u.mesh.position.distanceTo(window.VF.game.camera.getWorldPosition(new window.THREE.Vector3())).toFixed(2)),
        });
      });
      return out;
    });
    log('跑动中: ' + JSON.stringify(movingClips));
    const clips = movingClips.map((m) => m.clip).filter(Boolean);
    assert.ok(clips.length, '拿不到 AI 当前 clip');
    assert.ok(
      clips.every((c) => c === 'RifleRun' || c === 'AimIdle' || c === 'ShootAuto'),
      '有 AI 在跑却播了非持枪 clip: ' + JSON.stringify(clips)
    );

    // 近景抓拍：肉眼判断"有没有真握住"只能靠这个（数值只证明两只手落在枪管轴线上，
    // 握姿观感还得看图）。让 AI 自己朝玩家跑是不行的 —— 它会停下、会被推出画面，
    // 位置每帧都在变。所以这里**冻住主循环**（g.running=false），把一名 AI 直接摆到
    // 相机前 3.2m，用 SoldierVoxel.driveArmed 手动推进到稳态，再当场 render 并导出画布。
    // 导画布而不是 page.screenshot：后者会抓到合成器里的过期 GL 帧（本项目已踩过）。
    const closeInfo = await page.evaluate(() => {
      const THREE = window.THREE;
      const g = window.VF.game;
      const V = window.VF.SoldierVoxel;
      const r = g.renderer;
      const cam = g.camera;
      const u = (window.__aiPicked || []).find((x) => x.alive && x.mesh);
      if (!u || !r) return { error: '没有可用的 AI 或 renderer' };
      g.running = false; // 停主循环，否则它每帧会把位置/姿态改回去

      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      dir.y = 0;
      dir.normalize();
      const right = new THREE.Vector3(-dir.z, 0, dir.x);
      const eye = cam.getWorldPosition(new THREE.Vector3());
      // 站到玩家眼前 3.4m、略偏左
      const p = eye.clone().add(dir.clone().multiplyScalar(3.4)).add(right.clone().multiplyScalar(-0.6));
      p.y = u.mesh.position.y;
      u.mesh.position.copy(p);
      const face = eye.clone().sub(p);
      face.y = 0;
      face.normalize();
      u.mesh.rotation.y = Math.atan2(face.x, face.z) + Math.PI; // 转过来面对玩家（玩家本地 -Z 是前方）

      // 临时藏掉第一人称枪身和其余单位，免得挡住要看的东西（只影响这次抓拍）
      const hidden = [];
      const hide = (o) => { if (o && o.visible) { o.visible = false; hidden.push(o); } };
      hide(g.scene.getObjectByName('SoldierArtViewModel'));
      hide(g.scene.getObjectByName('RemotePlayer'));
      [].concat(g.ai.blue || [], g.ai.red || []).forEach((x) => { if (x !== u) hide(x.mesh); });

      // 专用相机：从 AI 的右前方 3/4 角度看上半身
      const rightOfAI = new THREE.Vector3(-face.z, 0, face.x);
      const cc = new THREE.PerspectiveCamera(34, r.domElement.width / r.domElement.height, 0.05, 60);
      cc.position.copy(p)
        .addScaledVector(face, 2.15)
        .addScaledVector(rightOfAI, 1.05)
        .add(new THREE.Vector3(0, 1.55, 0));
      const look = p.clone().add(new THREE.Vector3(0, 1.12, 0));
      cc.lookAt(look);
      cc.updateMatrixWorld(true);

      // 标记：红球=右手挂点、绿球=左手挂点、黄球=枪口、青线=两手连线、橙线=枪管轴线。
      // depthTest:false + renderOrder 让它们压在几何体上面，否则会被身体挡住看不见。
      const marks = [];
      const mkMat = (c) => new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false });
      const addBall = (p, c) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), mkMat(c));
        m.position.copy(p);
        m.renderOrder = 999;
        g.scene.add(m);
        marks.push(m);
      };
      const addLine = (a, b, c) => {
        const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
        const ln = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: c, depthTest: false }));
        ln.renderOrder = 998;
        g.scene.add(ln);
        marks.push(ln);
      };

      const shoot = (moving) => {
        for (let i = 0; i < 60; i++) {
          V.driveArmed(u.mesh, 0.016, { moving: moving, speedRatio: moving ? 1 : 0, onGround: true });
        }
        u.mesh.updateMatrixWorld(true);
        const S = u.mesh;
        const a2 = S.userData.glbAnim;
        const gun = a2.heldGun;
        const aa = a2.heldGunL || S.getObjectByName('Dummy002_L-Hand');
        const pr = S.getObjectByName('Dummy001_R-Hand').getWorldPosition(new THREE.Vector3());
        const pl = aa.getWorldPosition(new THREE.Vector3());
        const mo = gun.getObjectByName('Muzzle');
        const pm = mo ? mo.getWorldPosition(new THREE.Vector3()) : null;
        const pg = gun.getWorldPosition(new THREE.Vector3());
        addBall(pr, 0xff2a2a);
        addBall(pl, 0x2aff5a);
        addLine(pr, pl, 0x66ddff);
        if (pm) {
          addBall(pm, 0xffd400);
          addLine(pg, pm, 0xff8800);
        }
        r.render(g.scene, cc);
        const url = r.domElement.toDataURL('image/png');
        marks.splice(0).forEach((m) => {
          g.scene.remove(m);
          if (m.geometry) m.geometry.dispose();
          if (m.material) m.material.dispose();
        });
        return url;
      };
      const out = { run: shoot(true), idle: shoot(false) };
      const a = u.mesh.userData.glbAnim;
      const hand = u.mesh.getObjectByName('Dummy001_R-Hand');
      out.clip = a && a.current ? a.current.getClip().name : null;
      out.gunOnHand = !!(hand && a && a.heldGun && a.heldGun.parent === hand);
      hidden.forEach((o) => { o.visible = true; }); // 还原
      return out;
    });
    if (closeInfo.error) throw new Error(closeInfo.error);
    fs.writeFileSync(
      path.join(outDir, 'close-run.png'),
      Buffer.from(closeInfo.run.split(',')[1], 'base64')
    );
    fs.writeFileSync(
      path.join(outDir, 'close-idle.png'),
      Buffer.from(closeInfo.idle.split(',')[1], 'base64')
    );
    log('近景抓拍: 3.2m 处 AI，末帧 clip=' + closeInfo.clip + '，右手有枪=' + closeInfo.gunOnHand);

    for (const f of ['approach-0.png', 'approach-1.png', 'approach-2.png', 'close-run.png', 'close-idle.png']) {
      const p = path.join(outDir, f);
      assert.ok(fs.statSync(p).size > 30000, f + ' 截图疑似空白');
    }
    log('');
    log('主游戏 AI 持枪 + 持枪跑 ✓');
    log('截图: ' + path.relative(root, outDir) + '/');
    const realErrors = errors.filter((e) => !/theme\.mp3|zaohua-online/.test(e));
    if (realErrors.length) log('\n页面错误(' + realErrors.length + '):\n' + realErrors.slice(0, 10).join('\n'));
  } catch (e) {
    log('失败: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n', 'utf8');
  }
})();
