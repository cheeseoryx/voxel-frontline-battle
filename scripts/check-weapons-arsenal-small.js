/*
 * scripts/check-weapons-arsenal-small.js — 美术枪械在**小型遭遇战**武器选择界面里的验证
 *
 * 用法：node scripts/check-weapons-arsenal-small.js
 * 产物：tmp/weapons-arsenal-small/*.png + summary.txt
 *
 * 为什么和 check-weapons-arsenal.js 分开：主游戏跑根 js/，小型遭遇战
 * （modes/small-battle/index.html）用的是 modes/small-battle/js/ 下的**平行分叉
 * 副本** —— arsenal.js 和 weapon-viewmodels.js 各有一份，改根目录不会影响它。
 * 而主游戏首页的「小型遭遇战」入口正是跳到那一套（js/game-entry.js:60），
 * 所以两边都得覆盖，否则用户从那条路进去还是看到盒子枪。
 *
 * 两套的差异（写在这里省得下次再翻）：
 *   - 槽位是数字：1=主武器 2=副武器 4=投掷物（SLOT_CATEGORIES），不是 'primary'
 *   - 卡片属性是 [data-arsenal-id]，主游戏是 [data-arsenal-item]
 *   - 预览的静止角是 pivot.baseYaw = -Math.PI/2（主游戏是 0），
 *     因为它左右摇摆而不是整圈转，侧视才是可读角度
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'weapons-arsenal-small');

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

// 主武器槽（1）里有美术资产的；顺序和 WEAPON 表一致，方便和主游戏那份对读
const PRIMARY_ART = ['ak74', 'acr', 'scarh', 'm4a1', 'hk419', 'mp7', 'p90', 'mp5', 'm249', 'mk14ebr'];
// 库存里有、但美术还没给资产的 —— 必须安静回退程序化，不能开天窗
const PRIMARY_NO_ART = ['m200'];
// 副武器槽（2）= shotgun + pistol，这里只有 usp 有资产
const SECONDARY_ART = ['usp'];

async function pick(page, id) {
  return page.evaluate((wid) => {
    const A = window.VF.Arsenal;
    // 分类筛选会藏掉不在当前分类里的枪（m249 是 lmg、scarh 是 assault…），
    // 先切回"全部"再点卡片，走的就是用户真实的点选路径。
    A.category = 'all';
    A.render();
    const card = document.querySelector('#arsenal-list [data-arsenal-id="' + wid + '"]');
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
    page.on('console', (m) => consoleLogs.push('[' + m.type() + '] ' + m.text()));
    const netFails = [];
    page.on('requestfailed', (r) => netFails.push(r.url() + '  ' + (r.failure() && r.failure().errorText)));
    page.on('response', (r) => {
      if (r.status() >= 400) netFails.push('HTTP ' + r.status() + ' ' + r.url());
    });
    const KNOWN_MISSING = [/\/assets\/music\/theme\.mp3$/];
    const unexpectedNet = () => netFails.filter((s) => !KNOWN_MISSING.some((re) => re.test(s)));

    // 小型遭遇战启动链：直接进模式页，?mode=tdm 会直接停在兵种选择
    await page.goto(`http://127.0.0.1:${port}/modes/small-battle/index.html?mode=tdm`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('#class-overlay:not(.hidden)', { timeout: 60000 });

    // 打开军械库：优先走兵种选择面板上的"自定义/装备"真实入口，
    // 找不到就退回 VF.Arsenal.show({slot:1})（main.js 的 onCustomize 也是调它）。
    let opened = null;
    const entrySelectors = [
      '#class-overlay [data-class-customize]',
      '#class-overlay .class-customize',
      '#class-overlay #class-customize-btn',
      '.deploy-gear-slot[data-arsenal-slot]',
    ];
    for (const sel of entrySelectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click();
        if (await page.locator('#arsenal-overlay:not(.hidden)').count()) {
          opened = '兵种面板原生入口 ' + sel;
          break;
        }
      }
    }
    if (!opened) {
      opened = 'VF.Arsenal.show({slot:1})（没找到可见的原生入口）';
      await page.evaluate(() => window.VF.Arsenal.show({ slot: 1 }));
    }
    try {
      await page.waitForSelector('#arsenal-overlay:not(.hidden)', { timeout: 4000 });
    } catch (_) {
      opened = opened + ' → 没打开，改调 VF.Arsenal.show';
      await page.evaluate(() => window.VF.Arsenal.show({ slot: 1 }));
      await page.waitForSelector('#arsenal-overlay:not(.hidden)', { timeout: 15000 });
    }
    log('军械库已打开（' + opened + '）');

    // 预览会自转 / 摇摆。任它动，"每把枪截图都不同"就必然成立，断言等于没设。
    // 这里钩住 renderer.render，每帧把 yaw 钉回 baseYaw —— 那正是游戏自己的
    // 静止侧视角（本套 baseYaw = -PI/2，和主游戏的 0 不一样）。
    const locked = await page.evaluate(() => {
      const pv = window.VF.Arsenal._preview;
      if (!pv || pv.__angleLocked) return null;
      const yaw = typeof pv.baseYaw === 'number' ? pv.baseYaw : 0;
      const orig = pv.renderer.render.bind(pv.renderer);
      pv.renderer.render = function (scene, cam) {
        if (pv.pivot) pv.pivot.rotation.y = yaw;
        return orig(scene, cam);
      };
      pv.__angleLocked = true;
      return yaw;
    });
    log('预览角度锁定: rotation.y=' + locked + '（本套静止角，侧视）');

    // 先看还没预载完成时会不会开天窗：preview.pivot 必须有内容
    const firstPaint = await page.evaluate(() => {
      const pv = window.VF.Arsenal._preview;
      return { hasPreview: !!pv, pivotChildren: pv && pv.pivot ? pv.pivot.children.length : 0 };
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
    //   不带 opts → 必须还是程序化：本套的第一人称
    //     （modes/small-battle/js/soldier.js createViewModel）把双手以固定局部
    //     坐标 add 到 gun 上，是照 1.34m 的盒子枪量的；换 GLB 手就浮在枪外。
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
    assert.equal(contract.plainArt, false, 'buildGun(def) 不该返回美术枪（第一人称的手会浮在枪外）');
    assert.equal(contract.plainName, 'ViewGun', 'buildGun(def) 的程序化枪节点名应为 ViewGun');
    assert.equal(contract.optArt, true, 'buildGun(def, {art:true}) 应该返回美术枪');
    log('buildGun opt-in 契约: 默认程序化 ✓ / {art:true} 走 GLB ✓');

    // 本套第一人称必须还是"盒子枪 + 贴合的双手"。双手是 add 到 gun 上的固定
    // 局部坐标，一旦这里变成 GLB（原点在握把、真枪尺寸），手就会浮在枪外。
    const fpsViewModel = await page.evaluate(() => {
      const vm = window.VF.Soldier && window.VF.Soldier.createViewModel
        ? window.VF.Soldier.createViewModel('vanguard', 'acr')
        : null;
      if (!vm) return null;
      const gun = vm.gun;
      return {
        name: gun.name,
        isArt: !!(gun.userData && gun.userData.artAssets),
        hasRightHand: !!gun.getObjectByName('ViewRightHand'),
        hasLeftHand: !!gun.getObjectByName('ViewLeftHand'),
        hasMuzzle: !!gun.getObjectByName('Muzzle'),
      };
    });
    assert.ok(fpsViewModel, '拿不到 VF.Soldier.createViewModel');
    assert.equal(fpsViewModel.isArt, false, '小型遭遇战第一人称吃到了 GLB：双手会浮在枪外');
    assert.equal(fpsViewModel.hasRightHand, true, '第一人称枪上找不到 ViewRightHand');
    assert.equal(fpsViewModel.hasLeftHand, true, '第一人称枪上找不到 ViewLeftHand');
    assert.equal(fpsViewModel.hasMuzzle, true, '第一人称枪上找不到 Muzzle');
    log('小型遭遇战第一人称: 仍是盒子枪 + 双手贴合 ✓（节点 ' + fpsViewModel.name + '）');

    const shots = {};
    const checkOne = async (id, expectArt) => {
      const info = await pick(page, id);
      assert.equal(info.cardFound, true, id + ' 在军械库列表里找不到（SLOT_CATEGORIES 漏了？）');
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
      // 角度已由上面那个 render 钩子钉死，这里只需等画布刷一帧
      await page.waitForTimeout(220);
      const file = path.join(outDir, id + '.png');
      // ⚠️ 必须整页截图，**不能** clip：军械库是 position:fixed 的全屏 overlay，
      // Playwright 对 fixed overlay 上的 clip 截图会合成错（多次 clip 得到同一张图）。
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

    // 副武器是槽位 2（shotgun + pistol），得先切槽
    await page.evaluate(() => window.VF.Arsenal.setSlot(2));
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
    // 跨批次也要能区分：第一批（+Z 枪口，转 π）和第二批（-Z 枪口，不转）
    // 如果哪一批的 yawOffset 配反了，这里会出现"看着像但朝后"的枪，
    // 而它和别的枪仍然不同 —— 所以只靠两两不同不够，额外比一对跨批次的。
    assert.ok(
      Buffer.compare(shots['m249'], shots['ak74']) !== 0,
      'm249（第一批）与 ak74（第二批）画得一模一样，说明批次朝向没生效'
    );
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
