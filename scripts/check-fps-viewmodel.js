/*
 * scripts/check-fps-viewmodel.js — 第一人称美术化身在**主游戏**里的验证
 *
 * 用法：node scripts/check-fps-viewmodel.js
 *
 * 验的是 js/soldier.js 的 createArtViewModel：兵种 GLB 现场裁成 FPS viewmodel
 * （只留手臂 + 枪）。断言：
 *   1. player.viewModel 是美术化身（userData.artViewModel）
 *   2. 模型挂在动作库上（userData.glbAnim.actions 有持枪组 clip）
 *   3. 枪挂到了 Dummy001_R-Hand 的 ViewGunMount 上，且每帧解析解对齐
 *      （枪口朝身体正前方 —— 用世界方向点积判定，不靠肉眼）
 *   4. 裁剪面在生效（材质 clone 且带 clippingPlanes，共享材质的 userData.shared 未被污染）
 *   5. 状态机能切 clip：待机 → 跑 → 开火 → 换弹
 *   6. 五个状态各截一张图，且两两不同
 *
 * 顺带：脚本支持从命令行覆盖 VM_ART 参数做热调参（--eyeY=-0.14 这种），
 * 调好再把值写回 js/soldier.js 的 VM_ART。
 *
 * 产物：tmp/fps-viewmodel/*.png + summary.txt
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'fps-viewmodel');

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

// 命令行覆盖 VM_ART：--eyeY=-0.14 --cut=0.1
const OVERRIDES = {};
// 扫参：--sweep=cut:-0.22,0,0.1,0.2 —— 在同一姿势下逐值重建 viewmodel，各截一组图。
// 调 VM_ART 靠它比「改一次源码跑一遍」快得多（一次浏览器启动能扫 4~6 个值）。
let SWEEP = null;
process.argv.slice(2).forEach((a) => {
  const s = /^--sweep=([A-Za-z]+):(.+)$/.exec(a);
  if (s) {
    SWEEP = { key: s[1], values: s[2].split(',').map(Number).filter((v) => isFinite(v)) };
    return;
  }
  const m = /^--([A-Za-z]+)=(-?[\d.]+)$/.exec(a);
  if (m) OVERRIDES[m[1]] = Number(m[2]);
});

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
  const shots = {};
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('[console] ' + m.text());
    });
    // 「Failed to load resource」的 console 文本里没有 URL，location 对资源加载失败
    // 也是空的 → 另外用 response 事件把 404 的 URL 收集起来，白名单按 URL 过滤。
    const notFound = [];
    page.on('response', (r) => {
      if (r.status() === 404) notFound.push(r.url());
    });

    // 主游戏启动链（同 check-weapons-main.js）
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
    await page.waitForTimeout(2000);

    // 兵种 GLB + 动作库就绪（第一帧多半还没到，_awaitRoleArt 会重建一次）
    const roleReady = await page.evaluate(async () => {
      const V = window.VF.SoldierVoxel;
      if (!V || !V.preloadAll) return { ok: false, reason: 'no SoldierVoxel' };
      await V.preloadAll();
      const p = window.VF.game.player;
      const ready = {};
      Object.keys(V.CLASS_MODELS).forEach((c) => {
        ready[c] = V.isReady(c);
      });
      return { ok: V.isReady(p.classId), ready: ready, classId: p.classId };
    });
    log('兵种模型就绪: ' + JSON.stringify(roleReady));
    assert.ok(roleReady.ok, '当前兵种模型没就绪: ' + JSON.stringify(roleReady));

    // 重建 viewmodel（_awaitRoleArt 的 promise 可能还没跑完，这里显式推一次）。
    // 顺带把命令行覆盖打在 VM_ART 上 —— createArtViewModel 是在构建时读 VM_ART 的，
    // 所以「改参数 + 重建」就能热调参，不用改源码。
    const tuneViewmodel = (patch) =>
      page.evaluate((patch) => {
        const VM = window.VF.Soldier && window.VF.Soldier.VM_ART;
        if (!VM) return null;
        Object.keys(patch || {}).forEach((k) => {
          VM[k] = patch[k];
        });
        const p = window.VF.game.player;
        // 换了 viewmodel 就是换了 gunNode，Player 那套后坐的「静止姿势」必须重捕，
        // 否则会拿旧枪的 rest 去写新枪，后坐直接错位。
        p._gunRest = null;
        p._rebuildWeaponViewModel(p.classId, p._currentWeaponId());
        return {
          cut: VM.cut,
          eyeY: VM.eyeY,
          eyeZ: VM.eyeZ,
          gripBack: VM.gripBack,
          gunPos: VM.gunPos.slice(),
        };
      }, patch);

    const tuned = await tuneViewmodel(OVERRIDES);
    log('VM_ART: ' + JSON.stringify(tuned));
    await page.waitForTimeout(600);

    // ---- 结构断言 ----
    const info = await page.evaluate(() => {
      const p = window.VF.game.player;
      const vm = p.viewModel;
      const rig = vm && vm.getObjectByName('SoldierArtViewModel') !== null ? null : null;
      // 美术化身的外层就是它自己
      const isArt = !!(vm && vm.userData && vm.userData.artViewModel);
      const inner = vm && vm.children.find((c) => c.name && c.name.indexOf('SoldierVoxel_') === 0);
      const anim = inner && inner.userData && inner.userData.glbAnim;
      const hand = inner && (inner.getObjectByName('Dummy001_R-Hand') || inner.getObjectByName('Bip001-R-Hand'));
      const mount = hand && hand.getObjectByName('ViewGunMount');
      const gun = p.gunNode;
      const meshes = [];
      if (inner) {
        // 只体检「角色自己的网格」：枪挂在手上（ViewGunMount），背枪挂点在
        // Dummy001 上，两者都不该吃裁剪面，也不属于角色材质，必须跳过。
        const SKIP = { ViewGunMount: 1, Dummy001: 1 };
        const walk = (n, skip) => {
          if (!skip && (n.isMesh || n.isSkinnedMesh)) {
            const list = Array.isArray(n.material) ? n.material : [n.material];
            meshes.push({
              name: n.name || '(无名)',
              isSkinned: !!n.isSkinnedMesh,
              clipped: list.every((m) => m.clippingPlanes && m.clippingPlanes.length === 1),
              sharedFlag: list.some((m) => m.userData && m.userData.shared),
            });
          }
          const nextSkip = skip || !!SKIP[n.name];
          n.children.forEach((c) => walk(c, nextSkip));
        };
        walk(inner, false);
      }
      const head = inner && inner.getObjectByName('Bip001-Head');
      const dummy = inner && inner.getObjectByName('Dummy001');
      return {
        isArt: isArt,
        rootName: vm && vm.name,
        innerName: inner && inner.name,
        clips: anim ? Object.keys(anim.actions) : [],
        handName: hand && hand.name,
        mountFound: !!mount,
        gunParent: gun && gun.parent && gun.parent.name,
        meshCount: meshes.length,
        skinned: meshes.filter((m) => m.isSkinned).length,
        allClipped: meshes.length > 0 && meshes.every((m) => m.clipped),
        anyClipped: meshes.some((m) => m.clipped),
        // 裁剪现在是**可选**的：cut >= 0 表示关闭（实测任何"切掉离眼 N 厘米内的东西"
        // 的平面都会先把第一人称唯一看得见的那截手臂切没）。开着就必须全员吃到平面，
        // 关着就一个都不许有（否则是残留的旧材质）。
        cut: window.VF.Soldier.VM_ART.cut,
        pinHead: !!window.VF.Soldier.VM_ART.pinHead,
        anySharedFlag: meshes.some((m) => m.sharedFlag),
        headScale: head ? Number(head.scale.x.toFixed(3)) : null,
        backMountVisible: dummy ? dummy.visible : null,
        teamMarker: !!(inner && inner.getObjectByName('TeamMarker')),
        localClipping: !!window.VF.game.renderer.localClippingEnabled,
        pos: { x: Number(vm.position.x.toFixed(3)), y: Number(vm.position.y.toFixed(3)), z: Number(vm.position.z.toFixed(3)) },
      };
    });
    log('结构: ' + JSON.stringify(info, null, 0));

    assert.ok(info.isArt, 'player.viewModel 不是美术化身（还是程序化盒子？）: ' + info.rootName);
    assert.ok(info.innerName && info.innerName.indexOf('SoldierVoxel_') === 0, '没找到兵种模型: ' + info.innerName);
    assert.deepEqual(
      ['RifleRun', 'RifleCrouchAim', 'ShootAuto', 'AimIdle', 'Reload'].filter((c) => !info.clips.includes(c)),
      [],
      '动作库缺持枪组 clip（现有: ' + info.clips.join(',') + '）'
    );
    assert.ok(info.mountFound, '枪没挂在 ' + info.handName + ' 的 ViewGunMount 上');
    assert.equal(info.gunParent, 'ViewGunMount', 'gunNode 的父节点应该是 ViewGunMount（后坐靠两层分离）');
    if (info.cut < 0) {
      assert.ok(info.allClipped, '裁剪开着（cut=' + info.cut + '）却有网格没吃到裁剪面 → 会漏出身上的东西');
    } else {
      assert.ok(!info.anyClipped, '裁剪已关闭（cut=' + info.cut + '）却还有网格挂了裁剪面 → 要么漏 clone 要么材质残留');
    }
    assert.ok(info.pinHead, 'pinHead 关了：动画会把头带走（Sprint 前漂 33cm），相机就退到后脑勺后面了');
    assert.ok(!info.anySharedFlag, '材质带着 shared 标记：说明改到共享材质上了，会连累 AI/预览页');
    assert.ok(info.headScale != null && info.headScale < 0.01, '头骨没缩掉: ' + info.headScale);
    assert.equal(info.backMountVisible, false, 'Dummy001（背枪挂点）没藏，会横在脸前');
    assert.ok(!info.teamMarker, '阵营环没摘掉');
    assert.ok(info.localClipping, 'renderer.localClippingEnabled 没开，裁剪面不生效');

    // ---- 枪口朝向：解析解是否把枪摆正 ----
    const muzzle = await page.evaluate(() => {
      const THREE = window.THREE;
      const p = window.VF.game.player;
      const vm = p.viewModel;
      const inner = vm.children.find((c) => c.name && c.name.indexOf('SoldierVoxel_') === 0);
      const mount = inner.getObjectByName('Dummy001_R-Hand').getObjectByName('ViewGunMount');
      const gun = p.gunNode;
      vm.updateMatrixWorld(true);
      const qVm = new THREE.Quaternion();
      vm.getWorldQuaternion(qVm);
      const qGun = new THREE.Quaternion();
      gun.getWorldQuaternion(qGun);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(qVm);
      const gunFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(qGun);
      const gunUp = new THREE.Vector3(0, 1, 0).applyQuaternion(qGun);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(qVm);
      return {
        dotFwd: Number(gunFwd.dot(fwd).toFixed(3)),
        dotUp: Number(gunUp.dot(up).toFixed(3)),
        mountLocalZ: Number(mount.position.length().toFixed(3)),
      };
    });
    log('枪对齐: 枪口·前方向量=' + muzzle.dotFwd + '  枪上·身体上=' + muzzle.dotUp +
      '  手到枪原点距离=' + muzzle.mountLocalZ + 'm');
    assert.ok(muzzle.dotFwd > 0.98, '枪口没朝身体正前方（dot=' + muzzle.dotFwd + '）');
    assert.ok(muzzle.dotUp > 0.9, '枪身歪了（上方向 dot=' + muzzle.dotUp + '）');

    // ---- 状态机 + 截图 ----
    // 必须走真实输入：直接调 _vmTick 会被下一帧游戏主循环用真实状态覆盖掉。
    // 所以用键鼠 + 少量桩（换弹进度）把玩家真的推成那个状态，再等状态机收敛。
    const readState = () =>
      page.evaluate(() => {
        const p = window.VF.game.player;
        const inner = p.viewModel.children.find((c) => c.name && c.name.indexOf('SoldierVoxel_') === 0);
        const a = inner.userData.glbAnim;
        return {
          current: a.current && a.current.getClip().name,
          motionState: a.motionState,
          firing: !!a.firing,
          once: !!a.once,
          adsBlend: Number(p._adsBlend.toFixed(2)),
          crouchBlend: Number((p._crouchBlend || 0).toFixed(2)),
          speed: Number(Math.hypot(p.velocity.x, p.velocity.z).toFixed(2)),
          rigY: Number(inner.position.y.toFixed(3)),
        };
      });

    const reset = async () => {
      await page.keyboard.up('KeyW');
      await page.keyboard.up('ControlLeft');
      await page.evaluate(() => {
        const p = window.VF.game.player;
        const W = window.VF.game.weapons;
        p.aiming = false;
        W.firing = false;
        if (window.__origReload) W.getReloadAnim = window.__origReload;
      });
      await page.waitForTimeout(500);
    };

    // ---- 遮挡归因工具（诊断）----
    // 第一人称 viewmodel 出问题几乎都是「某个网格莫名占了半个屏幕」。
    // 把「角色网格」和「枪」分开渲染各出一张图，再报出各自的屏幕归一化包围盒，
    // 就能直接定位是哪一个，不用靠肉眼猜。
    const isoPick = () =>
      page.evaluate(() => {
        const p = window.VF.game.player;
        const vm = p.viewModel;
        const inner = vm.children.find((c) => c.name && c.name.indexOf('SoldierVoxel_') === 0);
        const SKIP = { ViewGunMount: 1, Dummy001: 1 };
        const role = [];
        const walk = (n, skip) => {
          if (!skip && (n.isMesh || n.isSkinnedMesh)) role.push(n);
          const ns = skip || !!SKIP[n.name];
          n.children.forEach((c) => walk(c, ns));
        };
        walk(inner, false);
        window.__isoRole = role;
        window.__isoGun = p.gunNode;
        return role.length;
      });

    const probe = () =>
      page.evaluate(() => {
        const THREE = window.THREE;
        const p = window.VF.game.player;
        const cam = window.VF.game.camera;
        const vm = p.viewModel;
        const inner = vm.children.find((c) => c.name && c.name.indexOf('SoldierVoxel_') === 0);
        const gun = window.__isoGun || p.gunNode;
        const hand = inner.getObjectByName('Dummy001_R-Hand');
        const mount = hand.getObjectByName('ViewGunMount');
        cam.updateMatrixWorld(true);
        const inv = cam.matrixWorldInverse;
        const proj = cam.projectionMatrix;
        // 不能把「世界→NDC」合成一个矩阵再乘 Vector3：相机后方的点 w<0，
        // 透视除法会把它翻到屏幕另一头，包围盒直接变成天文数字。分两步走，
        // 先用视空间 z 剔掉相机后方的点。
        const toScreen = (w) => {
          const v = w.clone().applyMatrix4(inv);
          if (v.z > -0.05) return null;
          const q = v.clone().applyMatrix4(proj); // Vector3.applyMatrix4 自带透视除法
          return [q.x * 0.5 + 0.5, 1 - (q.y * 0.5 + 0.5)];
        };
        const box = (objs, useBones) => {
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          const push = (w) => {
            const q = toScreen(w);
            if (!q) return;
            x0 = Math.min(x0, q[0]);
            x1 = Math.max(x1, q[0]);
            y0 = Math.min(y0, q[1]);
            y1 = Math.max(y1, q[1]);
          };
          objs.forEach((o) => {
            if (useBones && o.isSkinnedMesh && o.skeleton) {
              // 蒙皮网格的 Box3.setFromObject 不反映骨骼变形，投影会完全跑偏；
              // 用骨骼世界坐标近似它「在屏幕上占哪儿」。
              o.skeleton.bones.forEach((b) => push(b.getWorldPosition(new THREE.Vector3())));
            } else {
              const bb = new THREE.Box3().setFromObject(o);
              if (bb.isEmpty()) return;
              // 8 个角都要算：只取 min/max 两个角的话，只要有一个角落在近平面之后
              // 就会被剔掉，包围盒退化成一条线甚至一个点（实测就是这样）。
              for (let i = 0; i < 8; i++) {
                push(
                  new THREE.Vector3(
                    i & 1 ? bb.max.x : bb.min.x,
                    i & 2 ? bb.max.y : bb.min.y,
                    i & 4 ? bb.max.z : bb.min.z
                  )
                );
              }
            }
          });
          if (!isFinite(x0)) return null;
          return [x0, y0, x1, y1].map((v) => Number(v.toFixed(2)));
        };
        const view = (o) => {
          const v = new THREE.Vector3();
          o.getWorldPosition(v);
          v.applyMatrix4(inv);
          return [v.x, v.y, v.z].map((n) => Number(n.toFixed(3)));
        };
        const qRoot = new THREE.Quaternion();
        vm.getWorldQuaternion(qRoot);
        const qGun = new THREE.Quaternion();
        gun.getWorldQuaternion(qGun);
        const gunFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(qGun);
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(qRoot);
        return {
          fov: cam.fov,
          clip: inner.userData.glbAnim.current && inner.userData.glbAnim.current.getClip().name,
          dotFwd: Number(gunFwd.dot(fwd).toFixed(3)),
          gunView: view(gun), // 视空间：-z 是正前方，单位米
          handView: view(hand),
          mountLocal: [+mount.position.x.toFixed(3), +mount.position.y.toFixed(3), +mount.position.z.toFixed(3)],
          gunScale: +gun.scale.x.toFixed(3),
          vmVisible: vm.visible,
          gunVisible: gun.visible,
          gunBox: box([gun], false),
          roleBox: box(window.__isoRole || [], true),
        };
      });

    const isolate = async (mode) =>
      page.evaluate((mode) => {
        const p = window.VF.game.player;
        const gun = window.__isoGun || p.gunNode;
        const roles = window.__isoRole || [];
        // 玩家自己的「世界化身」：第一人称下如果它没被藏起来，会变成一坨黑块糊在脸上。
        // 记一次原始可见性，只在 none2 里动，其余模式复原。
        const av = p.object;
        if (!window.__isoAvatarHome) window.__isoAvatarHome = { obj: av, visible: av ? av.visible : null };
        const restoreAvatar = () => {
          const h = window.__isoAvatarHome;
          if (h && h.obj) h.obj.visible = h.visible;
        };
        restoreAvatar();
        // 恢复世界
        if (window.__isoHidden && mode !== 'solo') {
          window.__isoHidden.forEach((h) => { h.o.visible = h.v; });
          window.__isoHidden = null;
        }
        if (mode === 'role') {
          gun.visible = false;
          roles.forEach((m) => { m.visible = true; });
        } else if (mode === 'gun') {
          gun.visible = true;
          roles.forEach((m) => { m.visible = false; });
        } else if (mode === 'none') {
          // 对照：角色网格和枪都藏掉。还有东西留在画面里，就说明它俩都不是元凶。
          gun.visible = false;
          roles.forEach((m) => { m.visible = false; });
        } else if (mode === 'none2') {
          // 再把玩家的世界化身也藏掉
          gun.visible = false;
          roles.forEach((m) => { m.visible = false; });
          if (av) av.visible = false;
        } else if (mode === 'solo') {
          // 只留 viewmodel：把场景里除相机（viewmodel 挂在相机下）以外的子节点全藏掉。
          // 背景变纯色后一眼就能看清「手臂 + 枪」到底长什么样，不靠脑补。
          gun.visible = true;
          roles.forEach((m) => { m.visible = true; });
          const scene = window.VF.game.scene;
          window.__isoHidden = [];
          scene.children.forEach((c) => {
            // 灯光必须留着，否则整幅渲染成剪影，颜色问题看不出来。
            if (c === window.VF.game.camera || c.isLight) return;
            window.__isoHidden.push({ o: c, v: c.visible });
            c.visible = false;
          });
        } else {
          gun.visible = true;
          roles.forEach((m) => { m.visible = true; });
        }
        return { avatarWas: window.__isoAvatarHome.visible, avatarNow: av ? av.visible : null };
      }, mode);

    // 「右下角那块是谁」：把场景里所有可见网格按屏幕包围盒 + 离相机距离筛一遍，
    // 报出名字和祖先链。第一人称下画面里出现不该有的遮挡时，先跑它点名，别靠猜。
    const whoIsThere = () =>
      page.evaluate(() => {
        const THREE = window.THREE;
        const cam = window.VF.game.camera;
        const scene = window.VF.game.scene;
        cam.updateMatrixWorld(true);
        const inv = cam.matrixWorldInverse;
        const proj = cam.projectionMatrix;
        const v = new THREE.Vector3();
        const hits = [];
        scene.traverse((n) => {
          if (!n.isMesh && !n.isSkinnedMesh) return;
          let p = n.parent;
          let vis = n.visible;
          while (vis && p) {
            if (!p.visible) vis = false;
            p = p.parent;
          }
          if (!vis) return;
          const bb = new THREE.Box3().setFromObject(n);
          if (bb.isEmpty()) return;
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          let ok = 0;
          for (let i = 0; i < 8; i++) {
            v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
            v.applyMatrix4(inv);
            if (v.z > -0.05) continue;
            v.applyMatrix4(proj);
            const sx = v.x * 0.5 + 0.5;
            const sy = 1 - (v.y * 0.5 + 0.5);
            x0 = Math.min(x0, sx);
            x1 = Math.max(x1, sx);
            y0 = Math.min(y0, sy);
            y1 = Math.max(y1, sy);
            ok++;
          }
          if (!ok) return;
          const wp = new THREE.Vector3();
          n.getWorldPosition(wp);
          const dist = wp.applyMatrix4(inv).length();
          const nearRightBottom = x1 > 0.55 && y1 > 0.6;
          if (dist > 3 && !nearRightBottom) return;
          const chain = [];
          let q = n;
          for (let k = 0; k < 5 && q; k++) {
            chain.push((q.name || '(无名)') + (q.type === 'SkinnedMesh' ? '[skin]' : ''));
            q = q.parent;
          }
          hits.push({
            chain: chain.join(' < '),
            dist: Number(dist.toFixed(2)),
            box: [x0, y0, x1, y1].map((z) => Number(z.toFixed(2))),
            verts: bb.getSize(new THREE.Vector3()).length().toFixed(2),
          });
        });
        hits.sort((a, b) => a.dist - b.dist);
        return hits.slice(0, 10);
      });

    const boxStr = (b) => (b ? b.map((v) => v.toFixed(2)).join(',') : '(全在镜头后)');
    const vStr = (b) => b.map((v) => v.toFixed(3)).join(',');

    await isoPick(); // 先把「角色网格 / 枪」的引用抓下来，供隔离渲染用

    // ---- 冻结主循环 + 按需渲染一帧 ----
    // 为什么必须这么做：swiftshader 下 page.screenshot 一次要 ~1s，主循环在这期间照跑，
    // 于是「同一状态」连拍三张拿到的世界完全不同（小队已经跑散、相机也动了），
    // 隔离对比就失去意义。把 rAF 换成「只记录不调度」，再手动调用记录下来的那一帧，
    // 三次捕获就严格同一帧；渲染完不动画，合成器会一直显示这一帧。
    const freeze = () =>
      page.evaluate(() => {
        if (window.__origRaf) return false;
        window.__origRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = (cb) => {
          window.__pendingFrame = cb;
          return 0;
        };
        return true;
      });
    const stepFrame = () =>
      page.evaluate(() => {
        const cb = window.__pendingFrame;
        window.__pendingFrame = null;
        if (cb) cb(performance.now());
        return !!cb;
      });
    const unfreeze = () =>
      page.evaluate(() => {
        if (!window.__origRaf) return false;
        const raf = window.__origRaf;
        window.requestAnimationFrame = raf;
        window.__origRaf = null;
        const cb = window.__pendingFrame;
        window.__pendingFrame = null;
        if (cb) raf(cb);
        return true;
      });

    const CLIP_STEPS = [
      {
        tag: 's1_hip_idle',
        clip: 'AimIdle',
        setup: async () => {},
        settle: 900,
        iso: true,
      },
      {
        tag: 's2_run',
        clip: 'RifleRun',
        setup: async () => {
          await page.keyboard.down('KeyW');
        },
        settle: 1100,
        iso: true,
      },
      {
        tag: 's3_fire',
        clip: 'ShootAuto',
        setup: async () => {
          await page.evaluate(() => {
            window.VF.game.weapons.firing = true;
          });
        },
        settle: 900,
      },
      {
        tag: 's4_ads',
        clip: 'AimIdle', // 瞄准也是 AimIdle，差别在整体位移和世界 FOV
        setup: async () => {
          await page.evaluate(() => {
            window.VF.game.player.aiming = true;
          });
        },
        settle: 1100,
      },
      {
        tag: 's5_crouch',
        clip: 'RifleCrouchAim',
        setup: async () => {
          await page.keyboard.down('ControlLeft');
        },
        settle: 1300,
      },
      {
        tag: 's6_reload',
        clip: 'Reload',
        setup: async () => {
          await page.evaluate(() => {
            const W = window.VF.game.weapons;
            if (!window.__origReload) window.__origReload = W.getReloadAnim;
            W.getReloadAnim = () => 0.6;
          });
        },
        settle: 700,
      },
    ];

    for (const step of CLIP_STEPS) {
      await reset();
      await step.setup();
      await page.waitForTimeout(step.settle);
      const cur = await readState();
      const file = path.join(outDir, step.tag + '.png');
      await page.screenshot({ path: file });
      shots[step.tag] = fs.readFileSync(file);
      const okClip = cur.current === step.clip;
      log(
        (okClip ? '  ✔ ' : '  ✗ ') +
          step.tag.padEnd(12) +
          ' clip=' + String(cur.current).padEnd(15) +
          ' state=' + String(cur.motionState).padEnd(7) +
          ' ads=' + cur.adsBlend +
          ' 蹲=' + cur.crouchBlend +
          ' 速=' + cur.speed +
          ' rigY=' + cur.rigY +
          ' ' + Math.round(shots[step.tag].length / 1024) + 'KB'
      );

      // 遮挡归因：冻结主循环 → 同一帧里出三张（正常 / 只角色 / 只枪）+ 屏幕包围盒
      await freeze();
      await stepFrame();
      const pb = await probe();
      log(
        '      体位 ' + pb.clip + ' fov=' + pb.fov +
          ' 枪视空间=' + vStr(pb.gunView) + ' 手=' + vStr(pb.handView) +
          ' 枪口·前=' + pb.dotFwd
      );
      log('      枪:  屏幕盒 ' + boxStr(pb.gunBox) + '  缩放=' + pb.gunScale + ' 挂点局部位移=' + vStr(pb.mountLocal));
      log('      角色: 屏幕盒 ' + boxStr(pb.roleBox));
      if (step.iso) {
        await isolate('role');
        await stepFrame();
        await page.screenshot({ path: path.join(outDir, 'iso_' + step.tag + '_role.png') });
        await isolate('gun');
        await stepFrame();
        await page.screenshot({ path: path.join(outDir, 'iso_' + step.tag + '_gun.png') });
        await isolate('all');
        await stepFrame();
        await page.screenshot({ path: path.join(outDir, 'iso_' + step.tag + '_all.png') });
        await isolate('none');
        await stepFrame();
        await page.screenshot({ path: path.join(outDir, 'iso_' + step.tag + '_none.png') });
        await isolate('none2');
        await stepFrame();
        await page.screenshot({ path: path.join(outDir, 'iso_' + step.tag + '_none2.png') });
        const who = await whoIsThere();
        log('      藏掉角色+枪之后，靠近相机 / 落在右下角的可见网格:');
        who.forEach((h) => log('        ' + String(h.dist).padStart(6) + 'm 盒 ' + h.box.join(',') + '  尺寸' + h.verts + '  ' + h.chain));
        log('      * 还有黑块的话看 iso_' + step.tag + '_none2.png（再藏掉玩家世界化身）');
        await isolate('solo');
        await stepFrame();
        await page.screenshot({ path: path.join(outDir, 'iso_' + step.tag + '_solo.png') });
        await isolate('all');
        await stepFrame();
      }
      await unfreeze();

      assert.equal(cur.current, step.clip, step.tag + ' 期望 clip=' + step.clip + '，实到 ' + cur.current);
    }
    await reset();

    // ---- 扫参（可选）：同一待机体位下逐值重建，各出一组「只角色」图 ----
    // 「只角色」那张是关键：裁剪面切出来的断面如果是黑的，就说明切的位置在镜头视野里，
    // 得把 cut 往身体后方挪（挪到眼睛后面，断面自然落在视锥外）。
    if (SWEEP) {
      log('\n扫参 ' + SWEEP.key + '（待机体位，主相机 fov）:');
      for (const v of SWEEP.values) {
        const patch = {};
        patch[SWEEP.key] = v;
        await tuneViewmodel(patch);
        await page.waitForTimeout(500);
        await isoPick();
        await freeze();
        await stepFrame();
        const pb = await probe();
        const tag = 'sweep_' + SWEEP.key + '_' + String(v).replace('-', 'm').replace('.', 'p');
        await isolate('all');
        await stepFrame();
        await page.screenshot({ path: path.join(outDir, tag + '.png') });
        await isolate('role');
        await stepFrame();
        await page.screenshot({ path: path.join(outDir, tag + '_role.png') });
        await isolate('all');
        await unfreeze();
        log(
          '  ' + SWEEP.key + '=' + String(v).padEnd(6) +
            ' 枪屏盒 ' + boxStr(pb.gunBox) + '  角色屏盒 ' + boxStr(pb.roleBox) + '  → ' + tag + '.png'
        );
      }
    }

    const tags = CLIP_STEPS.map((s) => s.tag);
    for (let i = 0; i < tags.length; i++) {
      for (let k = i + 1; k < tags.length; k++) {
        assert.ok(
          Buffer.compare(shots[tags[i]], shots[tags[k]]) !== 0,
          tags[i] + ' 与 ' + tags[k] + ' 画面完全相同（状态机没真的切动作？）'
        );
      }
    }
    log('');
    log('五个状态画面两两不同 ✓');
    log('截图: ' + path.relative(root, outDir) + '/');

    // 既有白名单：这两个 404 跟本次改动无关（theme.mp3 一直都缺；zaohua-online.js 是
    // index.html 引用了但仓库里根本没有的文件），不算回归。
    const WHITELIST_404 = [/assets\/music\/theme\.mp3/, /zaohua-online\.js/];
    const bad404 = notFound.filter((u) => !WHITELIST_404.some((re) => re.test(u)));
    // console 里那条 404 报错没有 URL，只有当「非白名单 404 数为 0」时才把它当噪音滤掉
    const is404Noise = (e) => /404 \(Not Found\)/.test(e) && bad404.length === 0;
    const realErrors = errors.filter((e) => !is404Noise(e) && !WHITELIST_404.some((re) => re.test(e)));
    log('\n404 资源 ' + notFound.length + ' 个，非白名单 ' + bad404.length + ' 个：' + (bad404.join(' | ') || '(无)'));
    if (errors.length) {
      log('页面错误 ' + errors.length + ' 条，其中白名单/噪音 ' + (errors.length - realErrors.length) + ' 条：');
      errors.slice(0, 10).forEach((e) => log('    ' + e));
    }
    assert.deepEqual(realErrors, [], '有页面错误');
  } catch (e) {
    log('失败: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n', 'utf8');
  }
})();
