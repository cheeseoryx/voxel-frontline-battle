/*
 * scripts/check-anims-e2e.js — 动作库在真实游戏里的端到端验证
 *
 * 与 check-anims.js 的区别：那个是组件级（绕开游戏 UI 直接驱动 VF.SoldierVoxel），
 * 这个走完整游戏启动链，确认动作库真的被游戏加载并对兵种角色生效。
 *
 * 用法：node scripts/check-anims-e2e.js
 * 断言：
 *   1. 启动后 VF.SoldierVoxel.CLIP 的 15 个名字全部在运行时 actions 里存在
 *   2. 兵种模型就绪（preloadAll 成功），不再回退盒子兵
 *   3. 蹲伏状态能被 drive 状态机感知：蹲下走 → CrouchWalk，蹲下站 → CrouchIdle
 *   4. 开火 / 死亡一次性动作能触发，死亡是终态
 *   5. 0 pageerror
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
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
  const { server, port } = await serve();
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.VF && window.VF.SoldierVoxel, null, { timeout: 20000 });

    // 1. 预载
    const preloaded = await page.evaluate(() => window.VF.SoldierVoxel.preloadAll());
    assert.deepEqual(preloaded, [true, true, true, true], '四个兵种模型应全部预载成功');

    // 2. 建出角色，检查 15 个 action 都在
    const probe = await page.evaluate(() => {
      const V = window.VF.SoldierVoxel;
      const root = V.create('assault', { team: 'ally' });
      if (!root) return { ok: false, reason: 'create returned null' };
      const a = root.userData.glbAnim;
      const wanted = Object.keys(V.CLIP).map((k) => V.CLIP[k]);
      const missing = wanted.filter((n) => !a.actions[n]);
      const durations = {};
      wanted.forEach((n) => {
        if (a.actions[n]) durations[n] = +a.actions[n].getClip().duration.toFixed(3);
      });
      return {
        ok: true,
        missing: missing,
        durations: durations,
        current: a.current ? a.current.getClip().name : null,
      };
    });
    assert.equal(probe.ok, true, 'create 失败: ' + (probe.reason || ''));
    assert.deepEqual(probe.missing, [], '运行时缺少这些 action: ' + probe.missing.join(','));
    assert.equal(probe.current, 'Idle', 'create 后应停在 Idle，实际: ' + probe.current);

    // 3. 驱动状态机：蹲下走 / 蹲下站 应切到 CrouchWalk / CrouchIdle
    const drives = await page.evaluate(() => {
      const V = window.VF.SoldierVoxel;
      const S = window.VF.Soldier;
      function run(label, driveState, setup) {
        const root = V.create('assault', { team: 'ally' });
        if (setup) setup(root);
        for (let i = 0; i < 120; i++) {
          S.updateLocomotion(root, 1 / 60, driveState);
        }
        const a = root.userData.glbAnim;
        return { label: label, clip: a.current ? a.current.getClip().name : null, crouching: a.crouching };
      }
      const out = [];
      out.push(run('standIdle', { moving: false, speedRatio: 0, onGround: true }));
      out.push(run('walk', { moving: true, speedRatio: 0.5, onGround: true }));
      out.push(run('run', { moving: true, speedRatio: 0.95, onGround: true }));
      out.push(run('sprint', { moving: true, speedRatio: 1.2, onGround: true }));
      out.push(run('crouchIdle', { moving: false, speedRatio: 0, onGround: true }, (r) => S.setCrouchPose(r, true, {})));
      out.push(run('crouchWalk', { moving: true, speedRatio: 0.5, onGround: true }, (r) => S.setCrouchPose(r, true, {})));

      // 一次性动作
      const root = V.create('assault', { team: 'ally' });
      for (let i = 0; i < 30; i++) S.updateLocomotion(root, 1 / 60, { moving: false, speedRatio: 0, onGround: true });
      V.fire(root);
      S.updateLocomotion(root, 1 / 60, { moving: false, speedRatio: 0, onGround: true });
      const fireClip = root.userData.glbAnim.current.getClip().name;
      const fireOnce = !!root.userData.glbAnim.once;
      // 播完应回落到 Idle
      for (let i = 0; i < 90; i++) S.updateLocomotion(root, 1 / 60, { moving: false, speedRatio: 0, onGround: true });
      const afterFire = root.userData.glbAnim.current.getClip().name;
      // 死亡
      V.die(root);
      for (let i = 0; i < 300; i++) S.updateLocomotion(root, 1 / 60, { moving: false, speedRatio: 0, onGround: true });
      const deathClip = root.userData.glbAnim.current.getClip().name;
      const deadFlag = root.userData.glbAnim.dead;
      // 死亡后不再响应别的一次性动作
      V.fire(root);
      const fireAfterDeath = root.userData.glbAnim.current.getClip().name;

      return {
        states: out,
        fireClip: fireClip,
        fireOnce: fireOnce,
        afterFire: afterFire,
        deathClip: deathClip,
        deadFlag: deadFlag,
        fireAfterDeath: fireAfterDeath,
      };
    });

    const byLabel = {};
    drives.states.forEach((s) => { byLabel[s.label] = s; });
    assert.equal(byLabel.standIdle.clip, 'Idle', '站立待机应是 Idle');
    assert.equal(byLabel.walk.clip, 'Walk', '走应是 Walk');
    assert.equal(byLabel.run.clip, 'Run', '跑应是 Run');
    assert.equal(byLabel.sprint.clip, 'Sprint', '冲刺应是 Sprint');
    assert.equal(byLabel.crouchIdle.clip, 'CrouchIdle', '蹲下站应是 CrouchIdle，实际 ' + byLabel.crouchIdle.clip);
    assert.equal(byLabel.crouchWalk.clip, 'CrouchWalk', '蹲下走应是 CrouchWalk，实际 ' + byLabel.crouchWalk.clip);
    assert.equal(byLabel.crouchIdle.crouching, true, '蹲伏标志应被置起');

    assert.equal(drives.fireClip, 'Shoot', '开火应切到 Shoot，实际 ' + drives.fireClip);
    assert.equal(drives.fireOnce, true, '开火应进入一次性动作态');
    assert.equal(drives.afterFire, 'Idle', '开火播完应回落到 Idle，实际 ' + drives.afterFire);
    assert.equal(drives.deathClip, 'Death', '死亡应切到 Death，实际 ' + drives.deathClip);
    assert.equal(drives.deadFlag, true, '死亡标志应为 true');
    assert.equal(drives.fireAfterDeath, 'Death', '死亡后不应再响应开火');

    assert.deepEqual(errors, [], '页面不应有 pageerror');
    console.log('check-anims-e2e OK');
    console.log('  状态机: ' + drives.states.map((s) => s.label + '→' + s.clip).join('  '));
    console.log('  一次性: fire→' + drives.fireClip + ' 播完→' + drives.afterFire +
      '  die→' + drives.deathClip + ' (死在开枪后仍为 ' + drives.fireAfterDeath + ')');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error('check-anims-e2e FAIL:', e.message);
  process.exit(1);
});
