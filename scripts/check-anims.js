/*
 * scripts/check-anims.js — 动作库验证
 *
 * 用法：node scripts/check-anims.js
 * 断言：
 *   1. 动作库里实际有 15 个 clip，且 js/soldier-voxel.js 的 CLIP 名字全部对得上
 *   2. 每个 clip 停在中间帧渲染出的姿势两两不同（证明动作在驱动骨骼，不是空壳）
 *   3. drive() 状态机的 idle / walk / run / sprint / 蹲待机 / 蹲走 姿势互不相同
 *   4. 一次性动作 fire / reload / die 能触发且不报错，die 后保持终态
 * 产物：tmp/anims-check/*.png（人工复核姿势是否合理：持枪？蹲？倒地？）
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'anims-check');

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

function pngToFile(dataUrl, file) {
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
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
    const page = await browser.newPage({ viewport: { width: 460, height: 600 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/scripts/check-anims.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.AnimsCheck, null, { timeout: 15000 });

    const preloaded = await page.evaluate(() => window.AnimsCheck.preloadAll());
    assert.deepEqual(preloaded, [true, true, true, true], '四个兵种模型应全部预载成功');

    // 1. clip 名单对齐
    const expected = await page.evaluate(() => window.AnimsCheck.expectedClips());
    const actual = await page.evaluate(() => window.AnimsCheck.loadedClips());
    assert.ok(actual, '动作库加载失败');
    assert.deepEqual(
      expected.slice().sort(),
      actual.slice().sort(),
      'soldier-voxel.js 的 CLIP 与动作库里的 clip 对不上\n  代码要: ' +
        expected.join(',') + '\n  库里有: ' + actual.join(',')
    );
    console.log('clip 名单对齐（' + actual.length + ' 个）: ' + actual.join(', '));

    // 2. 每个 clip 中间帧截图
    const shots = {};
    for (const name of actual) {
      const info = await page.evaluate(
        (n) => window.AnimsCheck.poseClip(n, 0.4),
        name
      );
      assert.equal(info.ok, true, name + ' 摆姿势失败: ' + (info.reason || ''));
      const file = path.join(outDir, 'clip_' + name + '.png');
      pngToFile(info.png, file);
      shots[name] = info.png;
      assert.ok(info.png.length > 8000, name + ' 截图疑似空白');
    }

    // 3. drive 状态机
    const STATES = [
      ['idle', { moving: false, speedRatio: 0, onGround: true }, {}],
      ['walk', { moving: true, speedRatio: 0.5, onGround: true }, {}],
      ['run', { moving: true, speedRatio: 1.0, onGround: true }, {}],
      ['sprint', { moving: true, speedRatio: 1.2, onGround: true }, {}],
      ['crouchIdle', { moving: false, speedRatio: 0, onGround: true }, { crouch: true, seconds: 1.2 }],
      ['crouchWalk', { moving: true, speedRatio: 0.5, onGround: true }, { crouch: true, seconds: 1.2 }],
      ['fire', { moving: false, speedRatio: 0, onGround: true }, { once: 'fire', seconds: 0.25 }],
      ['reload', { moving: false, speedRatio: 0, onGround: true }, { once: 'reload', seconds: 1.0 }],
      ['die', { moving: false, speedRatio: 0, onGround: true }, { once: 'die', seconds: 2.8 }],
    ];
    const stateShots = {};
    for (const [label, state, opts] of STATES) {
      const info = await page.evaluate(
        (a) => window.AnimsCheck.poseState(a.s, a.o),
        { s: state, o: opts }
      );
      assert.equal(info.ok, true, label + ' 摆姿势失败: ' + (info.reason || ''));
      pngToFile(info.png, path.join(outDir, 'state_' + label + '.png'));
      stateShots[label] = info.png;
      assert.ok(info.png.length > 8000, label + ' 截图疑似空白');
    }

    // 4. 姿势两两不同（动作之间），以及状态机各状态互不相同
    function assertDistinct(map, tag) {
      const keys = Object.keys(map);
      const dup = [];
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          if (map[keys[i]] === map[keys[j]]) dup.push(keys[i] + '=' + keys[j]);
        }
      }
      assert.deepEqual(dup, [], tag + ' 这些姿势渲染出来完全相同:\n  ' + dup.join('\n  '));
    }
    assertDistinct(shots, 'clip');
    assertDistinct(stateShots, 'state');

    // 5. 死亡后必须是终态：再推进 2 秒姿势不再变（停在最后一帧）
    const dieA = await page.evaluate(() =>
      window.AnimsCheck.poseState({ moving: false, speedRatio: 0, onGround: true }, { once: 'die', seconds: 3.0 })
    );
    const dieB = await page.evaluate(() =>
      window.AnimsCheck.poseState({ moving: false, speedRatio: 0, onGround: true }, { once: 'die', seconds: 3.5 })
    );
    assert.equal(dieA.png, dieB.png, 'Death 播完后应停在最后一帧，不该继续变化');

    assert.deepEqual(errors, [], '页面不应有 pageerror');
    console.log(
      'check-anims OK：' + actual.length + ' 个 clip + ' + STATES.length +
        ' 个状态截图已写入 tmp/anims-check/'
    );
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error('check-anims FAIL:', e.message);
  process.exit(1);
});
