/*
 * scripts/check-fps-view.js — 第一人称化身预览
 *
 * 把 GLB 角色挂到相机上（相机放在头部骨骼处），渲染 FPS 视角截图，
 * 用来人工判断「玩家自己操纵的角色换成美术模型」后到底长什么样：
 * 躯干/手臂有没有入画、比例对不对、持枪姿势对不对。
 *
 * 用法：node scripts/check-fps-view.js
 * 产物：tmp/fps-view/*.png
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'fps-view');

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

const GUN = 'm4a1';
const CAM = { hideHead: true, hideBack: true, eyeY: -0.03, eyeZ: 0.1, near: 0.1 };
const AUTO = { weapon: GUN, gunRot: 'auto' };

const BASE = { ...CAM, ...AUTO, gripBack: 0.2, gunPos: [-0.03, 0.05, 0], vmFov: 55, near: 0.1 };
const SHIFT = (z, y) => ({ ...BASE, eyeZ: z, eyeY: y == null ? -0.04 : y });

const CUT = (z) => ({ ...BASE, armsOnly: z, eyeZ: 0.1, eyeY: -0.04 });

// ---- 离线 cut 扫参（--cut-sweep=…）----
// 为什么必须在**这个** harness 里扫：真机扫参拿到的截图整帧 ~80% 像素都在变
// （主循环在跑、DOM HUD 在跳、小队在走位），相邻两张根本不可比；裁剪又是 GPU 端
// 行为，不改几何/骨骼/包围盒，所以"屏盒"数值也判不出好坏 —— 只有像素算数。
// 这里没有主循环、没有 HUD、纯色天空背景，同一姿势每次渲染结果逐字节一致。
//
// 用法：node scripts/check-fps-view.js --cut-sweep=-0.55,-0.45,-0.35,-0.25,-0.15,-0.05
//      node scripts/check-fps-view.js --cut-sweep=-0.35,-0.25 --sweep-clips=AimIdle,RifleRun
const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : null;
};
const CUT_SWEEP = (argOf('cut-sweep') || '')
  .split(',')
  .map(Number)
  .filter((v) => isFinite(v));
const SWEEP_CLIPS = (argOf('sweep-clips') || 'AimIdle,RifleRun').split(',');

const CASES = [
  // p 组：定稿参数（游戏主相机 FOV 70 / cut -0.22 / eyeY -0.10）下选基础姿势。
  // 目标取景参照真机截图 tmp/weapons-main/ak74.png：枪占右下象限、枪口约在 (0.62,0.63)。
  { tag: 'p1_idle', clip: 'Idle', ...CUT(-0.22), eyeY: -0.1, eyeZ: 0, fov: 70, vmFov: 75 },
  { tag: 'p2_aim', clip: 'AimIdle', ...CUT(-0.22), eyeY: -0.1, eyeZ: 0, fov: 70, vmFov: 75 },
  { tag: 'p3_riflerun', clip: 'RifleRun', ...CUT(-0.22), eyeY: -0.1, eyeZ: 0, fov: 70, vmFov: 75 },
  { tag: 'p4_shootauto', clip: 'ShootAuto', ...CUT(-0.22), eyeY: -0.1, eyeZ: 0, fov: 70, vmFov: 75 },
  { tag: 'p5_aim_f48', clip: 'AimIdle', ...CUT(-0.22), eyeY: -0.1, eyeZ: 0, fov: 48, vmFov: 75 },
  { tag: 'p6_run_y20', clip: 'RifleRun', ...CUT(-0.22), eyeY: -0.2, eyeZ: 0, fov: 70, vmFov: 75 },
  { tag: 'p7_crouchaim', clip: 'RifleCrouchAim', ...CUT(-0.22), eyeY: -0.1, eyeZ: 0, fov: 70, vmFov: 75 },
  { tag: 'p8_reload', clip: 'Reload', ...CUT(-0.22), eyeY: -0.1, eyeZ: 0, fov: 70, vmFov: 75 },
];

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
    const page = await browser.newPage({ viewport: { width: 900, height: 540 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/scripts/check-fps-view.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.FpsView, null, { timeout: 15000 });
    await page.evaluate(() => window.FpsView.ready());

    for (const c of CASES) {
      const info = await page.evaluate(
        (o) => (o.debug ? window.FpsView.debugPose(o) : window.FpsView.pose(o)),
        c
      );
      if (!info.ok) {
        console.log('  [跳过] ' + c.tag + ' — ' + info.reason);
        continue;
      }
      pngToFile(info.png, path.join(outDir, c.tag + '.png'));
      console.log(
        '  ' + c.tag.padEnd(18) + ' clip=' + String(c.clip).padEnd(10) +
          ' head=' + JSON.stringify(info.headY) + ' gun=' + info.gun + ' ' +
          (info.png.length / 1024).toFixed(0) + 'KB'
      );
      if (info.vis) {
        console.log('      隐藏=' + JSON.stringify(info.vis.hidden) +
          ' 会渲染的网格=' + info.vis.rendered.length + ' 个 ' + JSON.stringify(info.vis.rendered));
      }
    }
    // 枪口朝向探针（数值判断，不靠肉眼）
    const probes = await page.evaluate((cam) => {
      const base = Object.assign({ clip: 'AimIdle' }, cam);
      const mk = (g) => window.FpsView.gunProbe(Object.assign({}, base, { weapon: 'm4a1', gunRot: 'auto', gripBack: g }));
      return {
        g00: mk(0),
        g20: mk(0.2),
        g30: mk(0.3),
        box00: window.FpsView.gunBox(Object.assign({}, base, { weapon: 'm4a1', gunRot: 'auto', gripBack: 0 })),
        box20: window.FpsView.gunBox(Object.assign({}, base, { weapon: 'm4a1', gunRot: 'auto', gripBack: 0.2 })),
      };
    }, CAM);
    console.log('\n握把补偿扫描（相机系：z 负=前 / 枪原点 z>0 说明原点还在镜头后）：');
    ['g00', 'g20', 'g30'].forEach((k) => {
      const p = probes[k];
      if (!p || !p.ok) {
        console.log('  ' + k.padEnd(6) + ' 探针失败 ' + (p ? p.reason : ''));
        return;
      }
      console.log(
        '  ' + k.padEnd(6) +
          ' 枪原点=' + JSON.stringify(p.origin).padEnd(24) +
          ' 枪口轴=' + JSON.stringify(p.axisZ).padEnd(22) +
          (p.muzzleForward ? ' ✔枪口朝前' : ' ✘枪口没朝前') +
          (p.muzzleUp ? ' ✔朝上' : ' ✘朝上')
      );
    });
    console.log('  枪在相机坐标系下的包围盒（z 负=镜头前方）：');
    ['box00', 'box20'].forEach((k) => {
      const b = probes[k];
      if (!b || !b.ok) return;
      console.log('    ' + k + ' min=' + JSON.stringify(b.min).padEnd(22) + ' max=' + JSON.stringify(b.max));
    });

    // 骨骼相对相机的坐标（相机在原点、朝 -Z）：定位什么挡在眼前
    const bones = await page.evaluate(() =>
      window.FpsView.boneMap({ clip: 'AimIdle', hideHead: true, t: 0.4 })
    );
    console.log('\n相机坐标系下的骨骼（x 右 / y 上 / z 前负后正 / d 到相机距离）：');
    bones.slice(0, 14).forEach((b) => {
      console.log(
        '  ' + b.name.padEnd(22) + ' x=' + String(b.x).padStart(7) +
          ' y=' + String(b.y).padStart(7) + ' z=' + String(b.z).padStart(7) +
          ' d=' + b.d
      );
    });

    // 视野中心挡了什么
    const rays = await page.evaluate(() =>
      window.FpsView.raycast({ clip: 'AimIdle', hideHead: true, t: 0.4 })
    );
    console.log('\n视野中心射线命中：');
    rays.forEach((r) => {
      console.log(
        '  far=' + String(r.near).padEnd(5) +
          (r.hit === null && !r.name
            ? ' 无遮挡（看得到场景）'
            : ' ' + r.name + '  ←父 ' + r.parent + '  距离 ' + r.dist + 'm')
      );
    });

    const tree = await page.evaluate(() => window.FpsView.tree({ hideHead: true }));
    console.log('\n模型根节点结构：');
    tree.forEach((l) => console.log('  ' + l));

    const insp = await page.evaluate(() =>
      window.FpsView.inspect({ clip: 'AimIdle', hideHead: true, t: 0.4 })
    );
    console.log('\n头部/蒙皮体检（hideHead=true）：');
    console.log('  头骨世界缩放 = ' + JSON.stringify(insp.headScale) +
      '  局部缩放 = ' + JSON.stringify(insp.headLocalScale));
    console.log('  头骨子节点 = ' + JSON.stringify(insp.headChildren));
    console.log('  名字含 head 的节点 = ' + JSON.stringify(insp.allHeadNamed));
    insp.skinned.forEach((s) => {
      console.log('  蒙皮网格 ' + s.name + ' 顶点=' + s.verts +
        ' 骨骼数=' + s.bones + ' 头骨在骨架里的下标=' + s.headIdx);
    });
    console.log('  所有网格（世界坐标）：');
    insp.meshes.forEach((m) => {
      console.log('    ' + m.name.padEnd(22) + ' vis=' + m.vis +
        ' 尺寸=' + JSON.stringify(m.size).padEnd(22) +
        ' 路径=' + m.path);
    });

    const scr = await page.evaluate(() =>
      window.FpsView.screenMap({ clip: 'AimIdle', hideHead: true, t: 0.4 })
    );
    console.log('\n骨骼在屏幕上的位置（x/y 0=正中，±1=边缘，>1 或 <-1 出画）：');
    scr.forEach((b) => {
      const inside = Math.abs(b.x) <= 1 && Math.abs(b.y) <= 1;
      console.log(
        '  ' + b.name.padEnd(22) +
          ' x=' + String(b.x).padStart(7) + ' y=' + String(b.y).padStart(7) +
          (inside ? '  ★在画面内' : '')
      );
    });

    // 参数扫描：用屏幕包围盒客观挑「枪摆在右下角、人体不糊脸」的组合
    const combos = [];
    [null, -0.22].forEach((cut) => {
      [-0.05, -0.15, -0.25].forEach((ey) => {
        [0.1, 0.0, -0.1].forEach((ez) => {
          [45, 55].forEach((fov) => {
            combos.push({ armsOnly: cut, eyeY: ey, eyeZ: ez, vmFov: fov });
          });
        });
      });
    });
    const swept = await page.evaluate((list) => {
      const base = window.__fpsBase;
      return list.map((c) => {
        const o = Object.assign({}, base, c);
        if (c.armsOnly == null) delete o.armsOnly;
        const r = window.FpsView.screenBox(o);
        return { c, gun: r && r.gun, bones: r && r.bones };
      });
    }, combos);
    console.log('\n参数扫描（屏幕归一化包围盒；x/y 越界即出画）：');
    swept.forEach((s) => {
      const g = s.gun;
      const inFrame = g && g[0] > -1 && g[2] < 1.02 && g[1] > -1.02 && g[3] < 0.3;
      console.log(
        '  裁=' + String(s.c.armsOnly).padStart(5) +
          ' eyeY=' + String(s.c.eyeY).padStart(5) + ' eyeZ=' + String(s.c.eyeZ).padStart(4) +
          ' fov=' + s.c.vmFov +
          ' | 枪=' + JSON.stringify(g) + ' 骨=' + JSON.stringify(s.bones) +
          (inFrame ? '  ✔枪完整落在右下' : '')
      );
    });

    // ---- 离线 cut 扫参：同姿势、纯背景，逐值出一张图 ----
    if (CUT_SWEEP.length) {
      console.log('\ncut 扫参（noWorld 纯背景 / 主相机 FOV 70 / m4a1 / eyeY-0.10）：');
      for (const clip of SWEEP_CLIPS) {
        for (const v of CUT_SWEEP) {
          const o = {
            ...BASE,
            armsOnly: v,
            clip,
            eyeY: -0.1,
            eyeZ: 0,
            fov: 70,
            vmFov: 75, // >=74 ⇒ 走单趟、用主相机 FOV，和真机取景一致
            noWorld: true,
          };
          const info = await page.evaluate((oo) => {
            const r = window.FpsView.pose(oo);
            const sb = window.FpsView.screenBox(Object.assign({}, oo, { vmFov: 70 }));
            return { ok: r.ok, reason: r.reason, png: r.png, box: sb };
          }, o);
          if (!info.ok) {
            console.log('  [跳过] cut=' + v + ' clip=' + clip + ' — ' + info.reason);
            continue;
          }
          const tag = 'cut_' + String(v).replace('-', 'm').replace('.', 'p') + '_' + clip;
          pngToFile(info.png, path.join(outDir, tag + '.png'));
          const fmt = (b) => (b ? b.map((n) => n.toFixed(2)).join(',') : '(空)');
          console.log(
            '  cut=' + String(v).padStart(6) + ' ' + clip.padEnd(10) +
              ' 枪屏盒=' + fmt(info.box && info.box.gun).padEnd(26) +
              ' 留骨屏盒=' + fmt(info.box && info.box.bones)
          );
        }
      }
    }

    console.log('\ncheck-fps-view OK：截图已写入 tmp/fps-view/');
    if (errors.length) console.log('pageerror: ' + errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error('check-fps-view FAIL:', e.message);
  process.exit(1);
});
