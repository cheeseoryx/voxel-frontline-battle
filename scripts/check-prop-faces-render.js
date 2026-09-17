/*
 * scripts/check-prop-faces-render.js — 块面微缩纹理 · 真机对比
 *
 * 用法：node scripts/check-prop-faces-render.js [propId ...]
 * 产物 tmp/prop-faces/<prop>-view-<yaw>.png   3/4 视角，A / A' / B / C 并排
 *      tmp/prop-faces/<prop>-faces-<yaw>.png  四个侧面的**正视**对比网格
 *                                            上排 = A（原始 GLB，yaw 同向旋转）
 *                                            下排 = B（体素 + 面纹理）
 *
 * 判什么：
 *   1. view：招牌 / 窗户 / 涂装这些"面上的图案"在体素版里有没有出现（B 明显比 C 花）。
 *   2. faces：对**同一个世界面方向**，A 和 B 显示的图案内容和朝向必须一致。
 *      这个判据不依赖"能不能读懂招牌上的字"，也不依赖我对 yaw 正负号的推理：
 *      yaw≠0 时若 YAW_MAP 的旋转方向搞反，B 的图案会相对 A 在面内转 90° 或镜像。
 *
 * 3/4 视角里 A 与 B 的"并排相同"不足以证明方向正确 —— 建筑两个面都露出来时，
 * 一个面转 90° 很容易被另一个面掩盖，所以必须补正视网格。
 *
 * yaw 符号约定：
 *   prop-stamp.js 的 q=1：世界 (x,z) → (x'=-z, z'=x)
 *     对照 three 的 R_y(θ)：x' = x cosθ + z sinθ, z' = -x sinθ + z cosθ
 *     θ=-90° 给 x'=-z, z'=x  ⇒ q=1 等价于绕 +Y 转 -90°
 *   prop-faces.js 的 YAW_R[1] 把 glb +X 映到世界 +Z，与上面一致。
 *   ⇒ A 侧（原始 GLB）参照图用 rotation.y = -yaw；A'（+yaw）是反例。
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'prop-faces');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
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

function saveDataUrl(file, url) {
  fs.writeFileSync(file, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

// 只比对四个侧立面（顶/底没有可读图案，且正视时会被自身遮住）
const SIDE_FACES = [2, 3, 4, 5];

(async () => {
  const props = process.argv.slice(2).length ? process.argv.slice(2) : ['hotel', 'house'];
  const yaws = [0, 90, 180, 270];
  fs.mkdirSync(outDir, { recursive: true });

  const { server, port } = await serve();
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const errors = [];
  const log = (s) => console.log(s);

  let failed = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); log('[pageerror] ' + e.message); });
    page.on('console', (m) => {
      if (m.type() === 'error') { errors.push('console: ' + m.text()); log('[console.error] ' + m.text()); }
    });
    await page.goto(`http://127.0.0.1:${port}/scripts/check-prop-faces.html`, { waitUntil: 'load' });
    try {
      await page.waitForFunction('window.CHECK_READY === true', null, { timeout: 30000 });
    } catch (e) {
      throw new Error('页面未就绪: ' + e.message);
    }

    const faceNames = await page.evaluate('CHECK.faceNames()');
    log('图集: ' + JSON.stringify(await page.evaluate('CHECK.atlas()')));
    log('清单: ' + JSON.stringify(await page.evaluate('CHECK.manifest()')));

    for (const pid of props) {
      const glbUrl = `http://127.0.0.1:${port}/assets/props/${pid}.glb`;
      for (const yaw of yaws) {
        try {
          // --- 1. 3/4 视角 ---
          const items = [];
          const a = await page.evaluate(([u, y]) => CHECK.glbView(u, y, -1), [glbUrl, yaw]);
          items.push({ url: a, label: `A 原始GLB (rot ${-yaw}°)` });
          if (yaw % 180 !== 0) {
            const a2 = await page.evaluate(([u, y]) => CHECK.glbView(u, y, +1), [glbUrl, yaw]);
            items.push({ url: a2, label: `A' 反号 (rot +${yaw}°)` });
          }
          const b = await page.evaluate(([p, y]) => CHECK.voxView(p, y), [pid, yaw]);
          items.push({ url: b, label: `B 体素+面纹理 (yaw ${yaw})` });
          const c = await page.evaluate(([p, y]) => CHECK.flatView(p, y), [pid, yaw]);
          items.push({ url: c, label: `C 同几何·关面纹理 (yaw ${yaw})` });
          saveDataUrl(path.join(outDir, `${pid}-view-${yaw}.png`),
            await page.evaluate((its) => CHECK.compose(its), items));

          // 只有 A / B 两格的对照（排除看错拼图顺序的可能）
          if (yaw % 180 !== 0) {
            saveDataUrl(path.join(outDir, `${pid}-pair-${yaw}.png`),
              await page.evaluate((its) => CHECK.compose(its),
                [{ url: a, label: `A 原始GLB rot ${-yaw}°` }, { url: b, label: `B 体素+面纹理 yaw ${yaw}` }]));
          }

          // --- 2. 四个侧面的正视对照网格 ---
          const grid = [];
          for (const f of SIDE_FACES) {
            grid.push({ url: await page.evaluate(([u, y, ff]) => CHECK.glbFace(u, y, ff, -1), [glbUrl, yaw, f]),
              label: `A [${pid} ${faceNames[f]}] rot ${-yaw}°` });
          }
          for (const f of SIDE_FACES) {
            grid.push({ url: await page.evaluate(([p, y, ff]) => CHECK.voxFace(p, y, ff), [pid, yaw, f]),
              label: `B [${pid} ${faceNames[f]}] yaw ${yaw}` });
          }
          saveDataUrl(path.join(outDir, `${pid}-faces-${yaw}.png`),
            await page.evaluate(([its, n]) => CHECK.compose(its, n), [grid, SIDE_FACES.length]));

          const st = await page.evaluate('CHECK.stats()');
          log(`${pid} yaw=${yaw}: 面槽位 ${st.faceSlots} / 带面chunk ${st.faceChunks} / chunk网格 ${st.chunkMeshes}`);
        } catch (e) {
          failed++;
          log(`  !! ${pid} yaw=${yaw} 失败: ${e.message}`);
        }
      }
    }
  } catch (e) {
    failed++;
    log('!! 顶层异常: ' + e.message);
  } finally {
    await browser.close();
    server.close();
  }

  const real = errors.filter((e) => !/\/assets\/music\/theme\.mp3|zaohua-online\.js|favicon/.test(e));
  if (real.length) {
    log('\n页面错误:');
    real.slice(0, 20).forEach((e) => log('  ' + e));
  }
  log(failed ? `\n失败 ${failed} 组` : '\n全部完成');
  process.exit(failed || real.length ? 1 : 0);
})();
