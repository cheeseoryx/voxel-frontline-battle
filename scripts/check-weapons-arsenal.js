/*
 * scripts/check-weapons-arsenal.js — 美术枪械在**武器选择界面**里的验证
 *
 * 用法：node scripts/check-weapons-arsenal.js
 * 产物：tmp/weapons-arsenal/*.png + summary.txt
 *
 * 覆盖的是 js/arsenal.js 的预览 canvas 那条路径：主菜单 → 单人 → 兵种选择 →
 * 点主武器栏打开军械库 → 逐把选中 → 检查预览里的枪是不是美术 GLB。
 *
 * 为什么单独一个：这条路径和第一人称 / 第三人称都不同 —— 它调的是
 * VF.WeaponViewModels.buildGun(def)。第一版接入时只改了 soldier.js 和
 * soldier-voxel.js，buildGun 还在拼盒子，所以选择界面里一直是方块枪。
 *
 * 另外这里第一次覆盖到"美术资产是共享几何体"这件事：arsenal.js 每次换枪
 * 都会 dispose 旧预览的几何体/材质，而 GLB 的那份是 CACHE 里跨消费点共享的，
 * 析构会把第一人称正在用的 GPU 缓冲一起扔掉。脚本会断言共享标记正确，
 * 保证 dispose 被跳过。
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'weapons-arsenal');

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

// 主武器栏里**应当**吃到美术资产的（= WEAPON_LOADOUT_ORDER 去掉手枪和没资产的）
const PRIMARY_ART = ['ak74', 'acr', 'scarh', 'm4a1', 'hk419', 'mp7', 'p90', 'mp5', 'm249', 'mk14ebr'];
// 库存里有、但美术还没给资产的 —— 必须安静回退程序化，不能开天窗
const PRIMARY_NO_ART = ['m200'];
const SECONDARY_ART = ['usp'];

async function pick(page, id) {
  return page.evaluate((wid) => {
    const A = window.VF.Arsenal;
    // 分类筛选会藏掉不在当前分类里的枪（m249 是 lmg、scarh 是 assault…），
    // 先切回"全部"再点卡片，走的就是用户真实的点选路径。
    A.category = 'all';
    A.render();
    const card = document.querySelector('#arsenal-list [data-arsenal-item="' + wid + '"]');
    if (card) card.click();
    const pv = A._preview;
    const gun = pv && pv.pivot && pv.pivot.children.length ? pv.pivot.children[0] : null;
    const mesh = gun ? gun.getObjectByName('WeaponMesh') : null;
    const geo = mesh ? mesh.geometry : null;
    const mat = mesh ? mesh.material : null;
    return {
      cardFound: !!card,
      selectedId: A.selectedId,
      gunName: gun ? gun.name : null,
      gunChildren: gun ? gun.children.length : 0,
      isArt: !!(gun && gun.userData && gun.userData.artAssets === true),
      meshFound: !!mesh,
      hasMap: !!(mat && mat.map),
      geoShared: !!(geo && geo.userData && geo.userData.shared),
      matShared: !!(mat && mat.userData && mat.userData.shared),
    };
  }, id);
}

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
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    page.on('pageerror', (e) => errors.push(e.message));
    const consoleLogs = [];
    page.on('console', (m) => {
      const t = m.text();
      consoleLogs.push('[' + m.type() + '] ' + t);
    });
    const netFails = [];
    page.on('requestfailed', (r) => netFails.push(r.url() + '  ' + (r.failure() && r.failure().errorText)));
    page.on('response', (r) => {
      if (r.status() >= 400) netFails.push('HTTP ' + r.status() + ' ' + r.url());
    });
    const KNOWN_MISSING = [/\/assets\/music\/theme\.mp3$/];
    const unexpectedNet = () => netFails.filter((s) => !KNOWN_MISSING.some((re) => re.test(s)));

    // 主游戏启动链：首页 → 枢纽 → 单人 → 兵种选择（军械库就是从这一步打开的）
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#enter-hub-btn:not([disabled])', { timeout: 60000 });
    await page.click('#enter-hub-btn');
    await page.waitForSelector('#mode-overlay:not(.hidden)', { timeout: 60000 });
    await page.click('[data-mode-action=solo]');
    await page.waitForSelector('#class-overlay:not(.hidden)', { timeout: 60000 });

    // 打开军械库：优先走真实入口（兵种 / 部署界面上的装备条），拿不到再直接调 API。
    // 入口是 js/ui.js _renderDeployGear() 生成的 .deploy-gear-slot[data-arsenal-slot]，
    // 点它 → js/arsenal.js 的委托监听 → VF.Arsenal.show()。
    let opened = null;
    const entrySelectors = [
      '#class-overlay .deploy-gear-slot[data-arsenal-slot="primary"]',
      '#soldier-loadout-strip .deploy-gear-slot[data-arsenal-slot="primary"]',
      '.deploy-gear-slot[data-arsenal-slot="primary"]',
    ];
    for (const sel of entrySelectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click();
        opened = '原生装备条 ' + sel;
        break;
      }
    }
    if (!opened) {
      opened = 'VF.Arsenal.show（没找到可见的原生入口）';
      await page.evaluate(() => window.VF.Arsenal.show({ slot: 'primary' }));
    }
    try {
      await page.waitForSelector('#arsenal-overlay:not(.hidden)', { timeout: 4000 });
    } catch (_) {
      opened = opened + ' → 没打开，改调 VF.Arsenal.show';
      await page.evaluate(() => window.VF.Arsenal.show({ slot: 'primary' }));
      await page.waitForSelector('#arsenal-overlay:not(.hidden)', { timeout: 15000 });
    }
    log('军械库已打开（' + opened + '）');

    // 预览会自转（pivot.rotation.y += dt * 0.55）。自转会让"每把枪截图都不同"
    // 变成必然成立 —— 那这条断言就白设了。这里钩住 renderer.render，每帧把角度
    // 钉回 0，截图才是可比的（0 度就是相机默认的 3/4 视角，最好看）。
    // 0.62 rad 那种角度会让枪几乎正对镜头，透视压得只剩一小团，别用。
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

    // 先看还没预载完成时会不会开天窗：preview.pivot 必须有内容
    const firstPaint = await page.evaluate(() => {
      const pv = window.VF.Arsenal._preview;
      return {
        hasPreview: !!pv,
        pivotChildren: pv && pv.pivot ? pv.pivot.children.length : 0,
      };
    });
    assert.ok(firstPaint.hasPreview, '军械库预览没建起来（VF.Arsenal._preview 为空）');
    assert.ok(firstPaint.pivotChildren > 0, '刚打开时预览空白（应该先画程序化枪）');
    log('首帧回退: pivot 子节点=' + firstPaint.pivotChildren + '（资产未到先画程序化枪，没空白）');

    await page.evaluate(() => window.VF.WeaponModels.preloadAll());
    const artState = await page.evaluate((ids) => {
      const W = window.VF.WeaponModels;
      const out = {};
      ids.forEach((id) => {
        out[id] = W.has(id);
      });
      return out;
    }, PRIMARY_ART.concat(SECONDARY_ART));
    log('美术枪械就绪: ' + JSON.stringify(artState));
    const missing = Object.keys(artState).filter((id) => !artState[id]);
    if (missing.length) {
      log('网络失败:');
      unexpectedNet().slice(0, 20).forEach((s) => log('  ' + s));
      log('相关控制台:');
      consoleLogs.filter((s) => /weapon|glb|gltf/i.test(s)).slice(0, 20).forEach((s) => log('  ' + s));
    }
    assert.deepEqual(missing, [], '这些枪的美术资产没就绪: ' + missing.join(', '));

    // 契约断言：buildGun 的美术分支是 opt-in。
    //   不带 opts → 必须还是程序化：forgeax/scripts/import-original-weapons.cjs
    //     靠它导出**原始程序化**武器做对照，默认给 GLB 会把基准弄坏；
    //   js/soldier.js 的 useCatalogGun 分支也不带 opts，同理不能被顶掉。
    //   带 {art:true} → 必须是 GLB（展示界面走的就是这条）。
    const contract = await page.evaluate(() => {
      const VM = window.VF.WeaponViewModels;
      const def = window.VF.WEAPONS && window.VF.WEAPONS['acr'];
      if (!VM || !def) return null;
      const plainish = VM.buildGun(def);
      const artish = VM.buildGun(def, { art: true });
      const isArt = (b) => !!(b && b.gun && b.gun.userData && b.gun.userData.artAssets);
      return { plainArt: isArt(plainish), optArt: isArt(artish), plainName: plainish && plainish.gun && plainish.gun.name };
    });
    assert.ok(contract, '拿不到 VF.WeaponViewModels / VF.WEAPONS.acr');
    assert.equal(contract.plainArt, false, 'buildGun(def) 不该返回美术枪（会弄坏 forgeax 导入和第一人称）');
    assert.equal(contract.plainName, 'ViewGun', 'buildGun(def) 的程序化枪节点名应为 ViewGun');
    assert.equal(contract.optArt, true, 'buildGun(def, {art:true}) 应该返回美术枪');
    log('buildGun opt-in 契约: 默认程序化 ✓ / {art:true} 走 GLB ✓');

    const shots = {};
    const checkOne = async (id, expectArt) => {
      const info = await pick(page, id);
      assert.equal(info.cardFound, true, id + ' 在军械库列表里找不到（WEAPON_LOADOUT_ORDER 漏了？）');
      assert.equal(info.selectedId, id, id + ' 点卡片没选中（selectedId=' + info.selectedId + '）');
      assert.ok(info.gunChildren > 0, id + ' 预览里没有枪体');
      if (expectArt) {
        assert.equal(info.isArt, true, id + ' 预览没吃到美术 GLB。' + JSON.stringify(info));
        assert.equal(info.meshFound, true, id + ' 预览里找不到 WeaponMesh。' + JSON.stringify(info));
        assert.equal(info.hasMap, true, id + ' 预览贴图没接上。' + JSON.stringify(info));
        // 共享标记：arsenal.js 换枪时会 dispose 旧预览，靠这两个标记跳过，
        // 否则会把第一人称 / 背枪正在用的 GPU 缓冲一起析构。
        assert.equal(info.geoShared, true, id + ' 几何体没打共享标记（会被 arsenal 析构）');
        assert.equal(info.matShared, true, id + ' 材质没打共享标记（会被 arsenal 析构）');
      } else {
        assert.equal(info.isArt, false, id + ' 本该回退程序化，却吃到了美术资产（配置写错？）');
        assert.equal(info.gunName, 'ViewGun', id + ' 预览枪体节点名不是 ViewGun');
      }
      // 角度已由上面那个 render 钩子钉死在 0，这里只需等画布刷一帧
      await page.waitForTimeout(220);
      const file = path.join(outDir, id + '.png');
      // ⚠️ 必须整页截图，**不能** clip：军械库是 position:fixed 的全屏 overlay，
      // Playwright 对 fixed overlay 上的 clip 截图会合成错（多次 clip 得到同一张图），
      // 那就正好掩盖"每把枪看着都一样"这种真问题。
      await page.screenshot({ path: file });
      shots[id] = fs.readFileSync(file);
      assert.ok(shots[id].length > 15000, id + ' 截图疑似空白（' + shots[id].length + ' 字节）');
      log(
        id.padEnd(8) +
          ' 卡片✓ 选中=' + info.selectedId +
          ' 节点=' + info.gunName +
          ' 美术=' + (info.isArt ? 'GLB' : '程序化回退') +
          ' 贴图=' + info.hasMap +
          ' 共享标记=' + info.geoShared + '/' + info.matShared
      );
    };

    log('');
    for (const id of PRIMARY_ART) await checkOne(id, true);
    for (const id of PRIMARY_NO_ART) await checkOne(id, false);

    // 副武器栏（手枪在另一个 slot，得切过去）
    await page.evaluate(() => window.VF.Arsenal.setSlot('secondary'));
    for (const id of SECONDARY_ART) await checkOne(id, true);

    // 六个新资产之间必须画得不一样（同一把枪的截图才会相同）
    const NEWS = ['acr', 'ak74', 'hk419', 'm4a1', 'mk14ebr', 'scarh'];
    for (let i = 0; i < NEWS.length; i++) {
      for (let k = i + 1; k < NEWS.length; k++) {
        assert.ok(
          Buffer.compare(shots[NEWS[i]], shots[NEWS[k]]) !== 0,
          NEWS[i] + ' 与 ' + NEWS[k] + ' 在选择界面里画得一模一样'
        );
      }
    }
    log('');
    log('新六把在武器选择界面里两两不同 ✓');
    log('截图: ' + path.relative(root, outDir) + '/');

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
