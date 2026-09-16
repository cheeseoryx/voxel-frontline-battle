/*
 * scripts/check-throwables.js — 美术投掷物（手雷 / 闪光弹 / 烟雾弹）链路验证
 *
 * 用法：node scripts/check-throwables.js
 * 产物：tmp/throwables/*.png + summary.txt
 *
 * 为什么要单开一个而不是并进 check-weapons-*.js：投掷物跟枪不是一类东西。
 *   - 长轴是 **Y**（竖着放、底面在 y≈0），枪是 Z；所以没有 yawOffset，
 *     几何体三轴归中（飞行时会随机转，原点必须在质心上才是自转）。
 *   - 没有枪口，GLB_CONFIG 里不写 muzzle → attachMuzzle 整段跳过。
 *   - 消费点完全不同：
 *       ① js/throwables.js makeMesh()         世界里的飞行体 / 落地体
 *       ② js/arsenal.js 的 grenade 槽预览      武器选择界面（本项目主打）
 *       ③ js/throwables.js _styleHeldItem()    第一人称手持件
 *     它不经过 buildGunProp / _mountBackWeapon，枪械那套脚本一条都覆盖不到。
 *
 * 两套代码都验：主游戏（根 js/）和小型遭遇战（modes/small-battle/js/ 平行分叉，
 * 它的军械库投掷物槽是数字 4，主游戏是字符串 'grenade'）。
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'throwables');

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

/** 美术给了资产的三个 */
const ART = ['frag', 'flash', 'smoke'];
/** 库存里有、但美术没给资产的 —— 必须安静回退程序化 */
const NO_ART = ['stun', 'molotov'];

const NAMES = { frag: '破片手雷', flash: '闪光弹', smoke: '烟雾弹', stun: '震撼弹', molotov: '燃烧瓶' };

/** 在页面里查一次 makeMesh 出来的东西 */
const MESH_PROBE = `(id) => {
  const T = window.VF.Throwables;
  if (!T || !T.makeMesh) return null;
  const m = T.makeMesh(id);
  const mesh = m.getObjectByName('WeaponMesh');
  if (!mesh) {
    return { name: m.name, isArt: false, meshFound: false };
  }
  const g = mesh.geometry;
  g.computeBoundingBox();
  const b = g.boundingBox;
  const mat = mesh.material;
  return {
    name: m.name,
    isArt: !!(m.userData && m.userData.artAssets === true),
    meshFound: true,
    hasMap: !!mat.map,
    // 世界里的飞行体要吃场景雾 → 材质必须是克隆的（shared=false, fog=true）
    matShared: !!(mat.userData && mat.userData.shared),
    matFog: mat.fog !== false,
    // 几何体三轴归中：飞行时绕质心自转，而不是绕底边画圈
    center: {
      x: +((b.min.x + b.max.x) / 2).toFixed(4),
      y: +((b.min.y + b.max.y) / 2).toFixed(4),
      z: +((b.min.z + b.max.z) / 2).toFixed(4),
    },
    size: {
      x: +(b.max.x - b.min.x).toFixed(3),
      y: +(b.max.y - b.min.y).toFixed(3),
      z: +(b.max.z - b.min.z).toFixed(3),
    },
    // 手雷没有枪口；挂上去会在旁边凭空多一个 MuzzleFlash
    hasMuzzle: !!m.getObjectByName('Muzzle'),
  };
}`;

/** 第一人称手持件：有美术资产时必须换掉程序化的雷/瓶/罐 */
const HELD_PROBE = `(id) => {
  const S = window.VF.Soldier;
  const T = window.VF.Throwables;
  if (!S || !S.createThrowableViewModel || !T || !T._styleHeldItem) return null;
  const node = S.createThrowableViewModel('assault', { team: 'ally' });
  T._styleHeldItem(node, id);
  const art = node.userData.artItem;
  const parts = node.userData.parts || {};
  return {
    artOk: !!art,
    artName: art ? art.name : null,
    artIsGlb: !!(art && art.userData && art.userData.artAssets === true),
    artShared: !!(art && art.getObjectByName('WeaponMesh') &&
      art.getObjectByName('WeaponMesh').material.userData.shared),
    procVisible: [parts.grenade, parts.bottle, parts.can].some(function (p) {
      return p && p.visible;
    }),
  };
}`;

function logLines() {
  const lines = [];
  return {
    lines: lines,
    log: (s) => {
      lines.push(s);
      console.log(s);
    },
  };
}

async function newPage(browser, errors, netFails, consoleLogs) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => consoleLogs.push('[' + m.type() + '] ' + m.text()));
  page.on('requestfailed', (r) => netFails.push(r.url() + '  ' + (r.failure() && r.failure().errorText)));
  page.on('response', (r) => {
    if (r.status() >= 400) netFails.push('HTTP ' + r.status() + ' ' + r.url());
  });
  return page;
}

// theme.mp3 没进仓库；zaohua-online.js 是 build-zaohua.mjs 的产物（已 gitignore），
// 主游戏 index.html 引用它必然 404。两者都是既有状态。与 check-fps-viewmodel.js 同白名单。
const KNOWN_MISSING = [/\/assets\/music\/theme\.mp3$/, /zaohua-online\.js/];
const unexpected = (netFails) => netFails.filter((s) => !KNOWN_MISSING.some((re) => re.test(s)));

/* ------------------------------- 主游戏 ------------------------------- */

async function checkMain(browser, port, log) {
  const errors = [];
  const netFails = [];
  const consoleLogs = [];
  const page = await newPage(browser, errors, netFails, consoleLogs);

  log('══ 主游戏（根 index.html / js/）══');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#enter-hub-btn:not([disabled])', { timeout: 60000 });
  await page.click('#enter-hub-btn');
  await page.waitForSelector('#mode-overlay:not(.hidden)', { timeout: 60000 });
  await page.click('[data-mode-action=solo]');
  await page.waitForSelector('#class-overlay:not(.hidden)', { timeout: 60000 });
  await page.evaluate(() => window.VF.WeaponModels.preloadAll());

  const ready = await page.evaluate((ids) => {
    const W = window.VF.WeaponModels;
    const out = {};
    ids.forEach((id) => {
      out[id] = W.has(id);
    });
    return out;
  }, ART);
  log('美术投掷物就绪: ' + JSON.stringify(ready));
  const missing = ART.filter((id) => !ready[id]);
  if (missing.length) {
    unexpected(netFails).slice(0, 20).forEach((s) => log('  网络: ' + s));
    consoleLogs.filter((s) => /throw|glb|gltf|grenade/i.test(s)).slice(0, 20).forEach((s) => log('  控制台: ' + s));
  }
  assert.deepEqual(missing, [], '这些投掷物的美术资产没就绪: ' + missing.join(', '));

  /* ---- ① 世界飞行体 ---- */
  for (const id of ART) {
    const info = await page.evaluate(`(${MESH_PROBE})('${id}')`);
    assert.ok(info, id + ' 拿不到 VF.Throwables.makeMesh');
    assert.equal(info.isArt, true, id + ' makeMesh 没吃到美术 GLB: ' + JSON.stringify(info));
    assert.equal(info.hasMap, true, id + ' 飞行体没贴图');
    assert.equal(info.hasMuzzle, false, id + ' 被挂上了枪口节点（投掷物不该有）');
    assert.ok(
      Math.abs(info.center.x) < 0.01 && Math.abs(info.center.y) < 0.01 && Math.abs(info.center.z) < 0.01,
      id + ' 几何体没归中（飞行时会绕底边画圈）: ' + JSON.stringify(info.center)
    );
    assert.equal(info.matShared, false, id + ' 世界飞行体用的是共享材质（应该克隆一份开雾）');
    assert.equal(info.matFog, true, id + ' 世界飞行体没开雾，远处会飘在雾外');
    log(
      ('  makeMesh ' + id).padEnd(22) +
        ' 美术=GLB 贴图=✓ 无枪口=✓ 归中=' + JSON.stringify(info.center) +
        ' 尺寸=' + info.size.x + '×' + info.size.y + '×' + info.size.z
    );
  }
  for (const id of NO_ART) {
    const info = await page.evaluate(`(${MESH_PROBE})('${id}')`);
    assert.ok(info, id + ' 拿不到 VF.Throwables.makeMesh');
    assert.equal(info.isArt, false, id + ' 没有美术资产，却吃到了 GLB（配置写错？）');
    log('  makeMesh ' + id.padEnd(12) + ' 程序化回退 ✓（美术还没给资产）');
  }

  /* ---- ③ 第一人称手持 ---- */
  for (const id of ART) {
    const h = await page.evaluate(`(${HELD_PROBE})('${id}')`);
    assert.ok(h, id + ' 拿不到 createThrowableViewModel / _styleHeldItem');
    assert.equal(h.artOk, true, id + ' 手持件没换成美术模型');
    assert.equal(h.artIsGlb, true, id + ' 手持件不是 GLB');
    assert.equal(h.procVisible, false, id + ' 换上美术件后程序化的雷/瓶/罐还露着');
    log('  手持 ' + (NAMES[id] + '(' + id + ')').padEnd(20) + ' 美术件=' + h.artOk + ' 程序化已隐藏=✓');
  }
  const noArtHeld = await page.evaluate(`(${HELD_PROBE})('stun')`);
  assert.equal(noArtHeld.artOk, false, 'stun 没有美术资产，手持件却换成了 GLB');
  assert.equal(noArtHeld.procVisible, true, 'stun 回退程序化，但三种外形全被藏了（会空手）');
  log('  手持 震撼弹(stun)        程序化回退 ✓（美术还没给资产）');

  /* ---- ② 武器选择界面 ---- */
  await page.evaluate(() => window.VF.Arsenal.show({ slot: 'primary' }));
  await page.waitForSelector('#arsenal-overlay:not(.hidden)', { timeout: 20000 });
  // 预览会自转；不钉住角度，"三个截图都不同"就是必然成立，断言等于没设。
  await page.evaluate(() => {
    const pv = window.VF.Arsenal._preview;
    if (!pv || pv.__angleLocked) return;
    const orig = pv.renderer.render.bind(pv.renderer);
    pv.renderer.render = function (scene, cam) {
      if (pv.pivot) pv.pivot.rotation.y = 0;
      return orig(scene, cam);
    };
    pv.__angleLocked = true;
  });
  await page.evaluate(() => window.VF.Arsenal.setSlot('grenade'));
  await page.waitForTimeout(120);

  const shots = {};
  for (const id of ART) {
    const info = await page.evaluate((wid) => {
      const A = window.VF.Arsenal;
      A.render();
      const card = document.querySelector('#arsenal-list [data-arsenal-item="' + wid + '"]');
      if (card) card.click();
      const pv = A._preview;
      const obj = pv && pv.pivot && pv.pivot.children.length ? pv.pivot.children[0] : null;
      const mesh = obj ? obj.getObjectByName('WeaponMesh') : null;
      const geo = mesh ? mesh.geometry : null;
      const mat = mesh ? mesh.material : null;
      return {
        cardFound: !!card,
        selectedId: A.selectedId,
        objName: obj ? obj.name : null,
        isArt: !!(obj && obj.userData && obj.userData.artAssets === true),
        hasMap: !!(mat && mat.map),
        geoShared: !!(geo && geo.userData && geo.userData.shared),
        matShared: !!(mat && mat.userData && mat.userData.shared),
      };
    }, id);
    assert.equal(info.cardFound, true, id + ' 投掷物槽里找不到卡片（GRENADE_CATALOG 漏了？）');
    assert.equal(info.selectedId, id, id + ' 点卡片没选中（selectedId=' + info.selectedId + '）');
    assert.equal(info.isArt, true, id + ' 选择界面没吃到美术 GLB: ' + JSON.stringify(info));
    assert.equal(info.hasMap, true, id + ' 选择界面没贴图');
    // 几何体是 CACHE 里共享的那份（世界飞行体也在用），必须跳过 dispose；
    // 材质则是 makeMesh 为世界用途克隆的私份（fog=true），预览自己持有、
    // 换枪时被 dispose 掉才是对的 —— 不然每换一次枪就漏一份材质。
    assert.equal(info.geoShared, true, id + ' 几何体没打共享标记（会被 arsenal 换枪时析构）');
    assert.equal(info.matShared, false, id + ' 预览材质不该是共享的（应克隆一份由预览自己持有）');
    await page.waitForTimeout(220);
    const file = path.join(outDir, 'main-' + id + '.png');
    // ⚠️ 整页截图，不要 clip：军械库是 position:fixed 全屏 overlay，clip 会合成错。
    await page.screenshot({ path: file });
    shots[id] = fs.readFileSync(file);
    assert.ok(shots[id].length > 15000, id + ' 截图疑似空白（' + shots[id].length + ' 字节）');
    log('  选择界面 ' + id.padEnd(8) + ' 卡片✓ 节点=' + info.objName + ' 美术=GLB 贴图=✓ 共享标记=✓');
  }
  log('  军械库 grenade 槽（原本只有 2D SVG 图标）现在有 3D 预览 ✓');

  for (let i = 0; i < ART.length; i++) {
    for (let k = i + 1; k < ART.length; k++) {
      assert.ok(
        Buffer.compare(shots[ART[i]], shots[ART[k]]) !== 0,
        ART[i] + ' 与 ' + ART[k] + ' 在选择界面里画得一模一样'
      );
    }
  }
  log('  三个投掷物在选择界面里两两不同 ✓');

  await page.close();
  return unexpected(netFails).concat(errors.map((e) => 'PAGEERROR ' + e));
}

/* ---------------------------- 小型遭遇战 ---------------------------- */

async function checkSmall(browser, port, log) {
  const errors = [];
  const netFails = [];
  const consoleLogs = [];
  const page = await newPage(browser, errors, netFails, consoleLogs);

  log('');
  log('══ 小型遭遇战（modes/small-battle/，平行分叉副本）══');
  await page.goto(`http://127.0.0.1:${port}/modes/small-battle/index.html?mode=tdm`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#class-overlay:not(.hidden)', { timeout: 60000 });
  await page.evaluate(() => window.VF.WeaponModels.preloadAll());

  const ready = await page.evaluate((ids) => {
    const W = window.VF.WeaponModels;
    const out = {};
    ids.forEach((id) => {
      out[id] = W.has(id);
    });
    return out;
  }, ART);
  const missing = ART.filter((id) => !ready[id]);
  if (missing.length) {
    unexpected(netFails).slice(0, 20).forEach((s) => log('  网络: ' + s));
  }
  assert.deepEqual(missing, [], '小型遭遇战里这些投掷物资产没就绪: ' + missing.join(', '));
  log('美术投掷物就绪: ' + JSON.stringify(ready) + '（两边共用根目录 ../../js/weapon-models.js）');

  for (const id of ART) {
    const info = await page.evaluate(`(${MESH_PROBE})('${id}')`);
    assert.equal(info.isArt, true, id + '（小地图）makeMesh 没吃到美术 GLB');
    assert.equal(info.hasMuzzle, false, id + '（小地图）被挂上了枪口节点');
    assert.ok(
      Math.abs(info.center.x) < 0.01 && Math.abs(info.center.y) < 0.01 && Math.abs(info.center.z) < 0.01,
      id + '（小地图）几何体没归中'
    );
    log('  makeMesh ' + id.padEnd(8) + ' 美术=GLB 无枪口=✓ 归中=✓');
  }

  // 小地图的军械库投掷物槽是**数字 4**，卡片属性是 [data-arsenal-id]
  await page.evaluate(() => window.VF.Arsenal.show({ slot: 4 }));
  await page.waitForSelector('#arsenal-overlay:not(.hidden)', { timeout: 20000 });
  await page.evaluate(() => {
    const pv = window.VF.Arsenal._preview;
    if (!pv || pv.__angleLocked) return;
    // 本套是左右摇摆（baseYaw 才是它的静止角），主游戏那边是 0
    const yaw = typeof pv.baseYaw === 'number' ? pv.baseYaw : 0;
    const orig = pv.renderer.render.bind(pv.renderer);
    pv.renderer.render = function (scene, cam) {
      if (pv.pivot) pv.pivot.rotation.y = yaw;
      return orig(scene, cam);
    };
    pv.__angleLocked = true;
  });

  const shots = {};
  for (const id of ART) {
    const info = await page.evaluate((wid) => {
      const A = window.VF.Arsenal;
      A.render();
      const card = document.querySelector('#arsenal-list [data-arsenal-id="' + wid + '"]');
      if (card) card.click();
      const pv = A._preview;
      const obj = pv && pv.pivot && pv.pivot.children.length ? pv.pivot.children[0] : null;
      const mesh = obj ? obj.getObjectByName('WeaponMesh') : null;
      return {
        cardFound: !!card,
        selectedId: A.selectedId,
        objName: obj ? obj.name : null,
        isArt: !!(obj && obj.userData && obj.userData.artAssets === true),
        hasMap: !!(mesh && mesh.material && mesh.material.map),
        geoShared: !!(mesh && mesh.geometry && mesh.geometry.userData && mesh.geometry.userData.shared),
      };
    }, id);
    assert.equal(info.cardFound, true, id + '（小地图）投掷物槽里找不到卡片');
    assert.equal(info.isArt, true, id + '（小地图）选择界面没吃到美术 GLB: ' + JSON.stringify(info));
    assert.equal(info.hasMap, true, id + '（小地图）选择界面没贴图');
    assert.equal(info.geoShared, true, id + '（小地图）几何体没打共享标记');
    // 本套换雷时会 dispose 旧件（_styleHeldItem），共享标记必须生效，
    // 否则会把世界飞行体 / 预览正在用的几何体一起析构。
    await page.waitForTimeout(220);
    const file = path.join(outDir, 'small-' + id + '.png');
    await page.screenshot({ path: file });
    shots[id] = fs.readFileSync(file);
    assert.ok(shots[id].length > 15000, id + '（小地图）截图疑似空白');
    log('  选择界面 ' + id.padEnd(8) + ' 卡片✓ 节点=' + info.objName + ' 美术=GLB 贴图=✓');
  }
  for (let i = 0; i < ART.length; i++) {
    for (let k = i + 1; k < ART.length; k++) {
      assert.ok(
        Buffer.compare(shots[ART[i]], shots[ART[k]]) !== 0,
        ART[i] + ' 与 ' + ART[k] + ' 在小型遭遇战的选择界面里画得一模一样'
      );
    }
  }
  log('  三个投掷物在小型遭遇战里两两不同 ✓');

  await page.close();
  return unexpected(netFails).concat(errors.map((e) => 'PAGEERROR ' + e));
}

/* ------------------------------- 主流程 ------------------------------- */

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, port } = await serve();
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const { lines, log } = logLines();
  try {
    const bad1 = await checkMain(browser, port, log);
    const bad2 = await checkSmall(browser, port, log);
    const bad = bad1.concat(bad2);
    if (bad.length) log('\n非预期失败(' + bad.length + '):\n' + bad.slice(0, 10).join('\n'));
    assert.deepEqual(bad, [], '有非预期的缺失/失败资源或页面错误（见上面日志）');
    log('');
    log('全部通过。截图: ' + path.relative(root, outDir) + '/');
  } catch (e) {
    log('失败: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n', 'utf8');
  }
})();
