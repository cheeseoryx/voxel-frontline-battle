# 体素角色外观（Soldier01–04）接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `assets/Roles/` 里的 4 个体素角色（Bip001 骨架 GLB）作为玩家可选外观接入游戏：烘焙资产 → 运行时模块 → 部署页选择器 → 展示位与联机同步。

**Architecture:** 新建 `js/soldier-voxel.js` 承载全部体素角色逻辑；`VF.Soldier.createClassSoldier` 按 `opts.skinId` 分发，盒子兵保持默认路径且永远可回退。动作只有 Walk/Run/Pick 三个 clip（同骨架直接套用，无 retarget）；待机 = Pick 第 0 帧冻结 + 程序化呼吸；武器背挂在 `Dummy001` 挂点。

**Tech Stack:** three.js（GLTFLoader + SkeletonUtils，已随 `js/vendor/three.gltf.global.js` 加载）、无构建静态站（Netlify）、node 22 + python 3.14/Pillow（仅烘焙期）、playwright（仅验证脚本）。

**Spec:** `docs/superpowers/specs/2026-09-11-voxel-character-skins-design.md`（已提交，含资产体检数据与决策依据，执行前必读）。

## Global Constraints

- 角色骨骼名与动作 track 按名字匹配：`Root_zhujue01` / `Bip001` / `Bip001-*` / `Dummy001` / `Dummy001_R-Hand` / `Dummy002_L-Hand`，共 34 节点（0 号是蒙皮网格节点）。
- 模型原生面朝 **+Z**，身高 1.8m 米制；`SoldierFacing` 包装层 `rotation.y = Math.PI`（与盒子兵一致）。
- 待机 clip 用 `Pick` 冻结在 `time = 0`（绑定姿势是 A-pose，绝不可用）。
- 皮肤 id 集合：`'box'`（默认，原盒子兵）+ `'voxel01'` … `'voxel04'`；localStorage 键 `vf_soldier_skin`。
- 任何加载失败一律静默回退盒子兵，不允许出现空模型或阻塞 UI。
- 烘焙产物输出到 `assets/characters/`（该目录进 git）；`assets/Roles/` 已在 `.gitignore`（提交 `29f10d9`）。
- 本仓库无测试框架：验证手段 = `node --check` 语法门 + 烘焙自检 + `scripts/check-roles.js` 无头浏览器截图。每个任务结束必须 `git commit`。
- 改动到 `js/*.js` 时，同步把 `index.html` 里该文件的 `?v=` 缓存令牌 bump 为 `voxelskin1`（`/js/*` 有 `max-age=3600`）。
- 提交信息结尾带 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。

---

### Task 1: 资产烘焙管线（44MB → ~6MB）

**Files:**
- Create: `scripts/bake-roles.js`
- Create: `scripts/lib/resize_png.py`
- Create: `assets/characters/`（产物：`soldier01.glb` … `soldier04.glb`、`soldier_anims.glb`）

**Interfaces:**
- Consumes: `assets/Roles/Soldier01_Skin.glb` … `Soldier04_Skin.glb`、`Soldier01_Walk_120.glb`、`Soldier01_Run_245.glb`、`Soldier01_Pick.glb`（已解压就位）。
- Produces: `assets/characters/soldier01..04.glb`（蒙皮网格，贴图 1024²，骨架节点名不变）；`assets/characters/soldier_anims.glb`（仅骨架 + `Walk` / `Run` / `Pick` 三个 clip）。后续 Task 3 的运行时模块按这些确切路径与 clip 名加载。

背景（spec §1）：三个动作 GLB 各自带了一份完整网格 + 879KB 贴图，动作数据本身只有几十 KB；02/03/04 的贴图是 4096²。烘焙做两件事：动作库剥到只剩骨架和 clip；贴图统一降到 1024²。

- [ ] **Step 1: 写贴图重采样助手 `scripts/lib/resize_png.py`**

```python
"""resize_png.py <in.png> <out.png> <size> — 等比缩放到 size×size。

仅供 scripts/bake-roles.js 调用；依赖 Pillow（pip install pillow）。
"""
import sys
from PIL import Image

src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src)
im.resize((size, size), Image.LANCZOS).save(dst, optimize=True)
```

- [ ] **Step 2: 写烘焙脚本 `scripts/bake-roles.js`**

完整内容：

```js
#!/usr/bin/env node
/*
 * scripts/bake-roles.js — 体素角色资产烘焙（44MB -> 约 6MB）
 *
 * 输入（.gitignore 排除的原始导出，assets/Roles/）：
 *   Soldier01~04_Skin.glb      蒙皮网格（02~04 内嵌 4096² PNG）
 *   Soldier01_Walk_120.glb     原地 Walk，1.2s，首尾同姿势
 *   Soldier01_Run_245.glb      原地 Run，0.8s，首尾同姿势
 *   Soldier01_Pick.glb         Pick，1.6s，第 0 帧是可用站姿
 *
 * 输出（提交进仓库，assets/characters/）：
 *   soldier01.glb … soldier04.glb   蒙皮网格，贴图统一 1024²
 *   soldier_anims.glb               仅骨架 + Walk/Run/Pick 三个 clip
 *
 * 用法：node scripts/bake-roles.js
 * 依赖：python + Pillow（仅贴图重采样；缺失时明确报错并中止，不产出半成品）
 *
 * 安全：全部产物先写 *.tmp，自检通过后才 rename 替换正式文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'Roles');
const OUT = path.join(ROOT, 'assets', 'characters');
const RESIZE_PY = path.join(__dirname, 'lib', 'resize_png.py');
const TEX_SIZE = 1024;

const SKINS = [
  { src: 'Soldier01_Skin.glb', out: 'soldier01.glb' },
  { src: 'Soldier02_Skin.glb', out: 'soldier02.glb' },
  { src: 'Soldier03_Skin.glb', out: 'soldier03.glb' },
  { src: 'Soldier04_Skin.glb', out: 'soldier04.glb' },
];
const ANIMS = [
  { src: 'Soldier01_Walk_120.glb', name: 'Walk' },
  { src: 'Soldier01_Run_245.glb', name: 'Run' },
  { src: 'Soldier01_Pick.glb', name: 'Pick' },
];

/* ---------- GLB 读写 ---------- */

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('不是 GLB: ' + file);
  }
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  const binOfs = 20 + jsonLen + 8; // 跳过 BIN chunk 头（本批文件 JSON 在前 BIN 在后）
  return { json, bin: buf.slice(binOfs) };
}

function writeGlb(file, json, bin) {
  let jsonStr = JSON.stringify(json);
  while (jsonStr.length % 4) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const binPad = (4 - (bin.length % 4)) % 4;
  const binBuf = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binBuf.length, 0);
  bh.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
  fs.writeFileSync(file, Buffer.concat([head, jh, jsonBuf, bh, binBuf]));
}

// 用 newData 替换第 replaceIndex 个 bufferView 并重建 BIN（4 字节对齐）。
// bufferView 索引保持不变，byteOffset 重排。
function repackBin(glb, replaceIndex, newData) {
  const parts = [];
  let offset = 0;
  const newViews = glb.json.bufferViews.map((v, i) => {
    const data =
      i === replaceIndex
        ? newData
        : glb.bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    const nv = { buffer: 0, byteLength: data.length };
    if (offset) nv.byteOffset = offset;
    if (v.byteStride != null) nv.byteStride = v.byteStride;
    if (v.target != null) nv.target = v.target;
    if (v.name) nv.name = v.name;
    parts.push(data);
    offset += data.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      parts.push(Buffer.alloc(pad));
      offset += pad;
    }
    return nv;
  });
  const json = Object.assign({}, glb.json, { bufferViews: newViews });
  json.buffers = [{ byteLength: offset }];
  return { json, bin: Buffer.concat(parts) };
}

/* ---------- PNG ---------- */

function pngSize(png) {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是 PNG（或文件头损坏）');
  }
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

function resizePng(png, size) {
  const tmpIn = path.join(OUT, '_bake_in.png');
  const tmpOut = path.join(OUT, '_bake_out.png');
  fs.writeFileSync(tmpIn, png);
  try {
    execFileSync('python', [RESIZE_PY, tmpIn, tmpOut, String(size)], {
      stdio: 'pipe',
    });
  } catch (e) {
    throw new Error(
      '贴图重采样失败：需要 python + Pillow（pip install pillow）。' +
        (e.stderr ? '\n' + e.stderr.toString() : '')
    );
  }
  const out = fs.readFileSync(tmpOut);
  fs.unlinkSync(tmpIn);
  fs.unlinkSync(tmpOut);
  return out;
}

/* ---------- 蒙皮烘焙 ---------- */

function boneNames(json) {
  return json.nodes
    .filter((n) => n.name && n.name.indexOf('Bip001') === 0)
    .map((n) => n.name)
    .sort();
}

function bakeSkin(entry) {
  const srcPath = path.join(SRC, entry.src);
  const glb = readGlb(srcPath);
  const json = glb.json;
  const img = json.images && json.images[0];
  if (!img || img.bufferView == null) {
    throw new Error(entry.src + ' 没有内嵌贴图');
  }
  const view = json.bufferViews[img.bufferView];
  const png = glb.bin.slice(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  const dim = pngSize(png);

  let baked = glb;
  if (dim.w > TEX_SIZE || dim.h > TEX_SIZE) {
    baked = repackBin(glb, img.bufferView, resizePng(png, TEX_SIZE));
  }

  const tmpPath = path.join(OUT, entry.out + '.tmp');
  writeGlb(tmpPath, baked.json, baked.bin);

  // 自检：重读产物，顶点数 / 包围盒 / 骨骼名 / 贴图尺寸与原始一致
  const check = readGlb(tmpPath);
  const prim0 = json.meshes[0].primitives[0];
  const prim1 = check.json.meshes[0].primitives[0];
  const posA = json.accessors[prim0.attributes.POSITION];
  const posB = check.json.accessors[prim1.attributes.POSITION];
  if (posA.count !== posB.count) throw new Error(entry.out + ' 顶点数不一致');
  if (JSON.stringify(posA.min) !== JSON.stringify(posB.min)) {
    throw new Error(entry.out + ' 包围盒 min 不一致');
  }
  if (JSON.stringify(boneNames(json)) !== JSON.stringify(boneNames(check.json))) {
    throw new Error(entry.out + ' 骨骼名不一致');
  }
  const outView = check.json.bufferViews[check.json.images[0].bufferView];
  const outPng = check.bin.slice(outView.byteOffset || 0, (outView.byteOffset || 0) + outView.byteLength);
  const outDim = pngSize(outPng);
  if (outDim.w > TEX_SIZE || outDim.h > TEX_SIZE) {
    throw new Error(entry.out + ' 贴图未降到 ' + TEX_SIZE);
  }
  const size = fs.statSync(tmpPath).size;
  fs.renameSync(tmpPath, path.join(OUT, entry.out));
  console.log(
    'bake skin ' + entry.out + '  tex ' + dim.w + '->' + outDim.w +
    '  ' + (size / 1048576).toFixed(2) + 'MB'
  );
  return boneNames(check.json);
}

/* ---------- 动作库烘焙 ---------- */

// 三个动作文件共享同一副 34 节点骨架（0 号是蒙皮网格节点，1..33 是骨骼）。
// 动作库只保留 1..33 号节点（索引整体 -1），合并三个 clip 的 accessor 数据。
function bakeAnims(skinBones) {
  const base = readGlb(path.join(SRC, ANIMS[0].src));
  const nodes = base.json.nodes.slice(1).map((n) => {
    const node = { name: n.name };
    if (n.translation) node.translation = n.translation;
    if (n.rotation) node.rotation = n.rotation;
    if (n.scale) node.scale = n.scale;
    if (n.children) node.children = n.children.map((c) => c - 1);
    return node;
  });

  const json = {
    asset: { version: '2.0', generator: 'bake-roles.js (UE5 voxel soldier exports)' },
    scene: 0,
    scenes: [{ nodes: [0] }], // 旧 1 号 Root_zhujue01 -> 新 0 号
    nodes: nodes,
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
    animations: [],
  };
  const parts = [];
  let offset = 0;

  ANIMS.forEach((entry) => {
    const src = readGlb(path.join(SRC, entry.src));
    const anim = src.json.animations && src.json.animations[0];
    if (!anim) throw new Error(entry.src + ' 没有动作');
    const accMap = new Map();
    const remapAccessor = (oldIndex) => {
      if (accMap.has(oldIndex)) return accMap.get(oldIndex);
      const acc = Object.assign({}, src.json.accessors[oldIndex]);
      const view = src.json.bufferViews[acc.bufferView];
      const data = src.bin.slice(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
      const nv = { buffer: 0, byteLength: data.length };
      if (offset) nv.byteOffset = offset;
      json.bufferViews.push(nv);
      parts.push(data);
      offset += data.length;
      const pad = (4 - (offset % 4)) % 4;
      if (pad) {
        parts.push(Buffer.alloc(pad));
        offset += pad;
      }
      acc.bufferView = json.bufferViews.length - 1;
      json.accessors.push(acc);
      accMap.set(oldIndex, json.accessors.length - 1);
      return accMap.get(oldIndex);
    };
    const samplers = anim.samplers.map((s) => ({
      input: remapAccessor(s.input),
      output: remapAccessor(s.output),
      interpolation: s.interpolation || 'LINEAR',
    }));
    const channels = anim.channels.map((c) => ({
      sampler: c.sampler,
      target: { node: c.target.node - 1, path: c.target.path },
    }));
    json.animations.push({ name: entry.name, samplers: samplers, channels: channels });
  });

  json.buffers[0].byteLength = offset;

  const tmpPath = path.join(OUT, 'soldier_anims.glb.tmp');
  writeGlb(tmpPath, json, Buffer.concat(parts));

  // 自检：重读产物，clip 名齐全、索引不越界、动作骨骼名 ⊆ 蒙皮骨骼名
  const check = readGlb(tmpPath);
  const names = check.json.animations.map((a) => a.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['Pick', 'Run', 'Walk'])) {
    throw new Error('soldier_anims.glb clip 名不对: ' + names.join(','));
  }
  check.json.animations.forEach((a) => {
    a.channels.forEach((c) => {
      if (c.target.node < 0 || c.target.node >= check.json.nodes.length) {
        throw new Error('soldier_anims.glb 存在越界节点索引');
      }
    });
    a.samplers.forEach((s) => {
      if (s.input >= check.json.accessors.length || s.output >= check.json.accessors.length) {
        throw new Error('soldier_anims.glb 存在越界 accessor 索引');
      }
    });
  });
  const animBoneSet = new Set(
    check.json.nodes.filter((n) => n.name && n.name.indexOf('Bip001') === 0).map((n) => n.name)
  );
  skinBones.forEach((b) => {
    if (!animBoneSet.has(b)) throw new Error('动作库缺少骨骼: ' + b);
  });
  const size = fs.statSync(tmpPath).size;
  fs.renameSync(tmpPath, path.join(OUT, 'soldier_anims.glb'));
  console.log('bake anims soldier_anims.glb  ' + (size / 1024).toFixed(0) + 'KB');
}

/* ---------- main ---------- */

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  SKINS.forEach((s) => {
    if (!fs.existsSync(path.join(SRC, s.src))) throw new Error('缺输入: ' + s.src);
  });
  ANIMS.forEach((a) => {
    if (!fs.existsSync(path.join(SRC, a.src))) throw new Error('缺输入: ' + a.src);
  });
  const skinBones = bakeSkin(SKINS[0]);
  SKINS.slice(1).forEach(bakeSkin);
  bakeAnims(skinBones);
  console.log('done. 记得把 index.html 相关 js 的 ?v= 令牌 bump 为 voxelskin1');
}

main();
```

- [ ] **Step 3: 语法检查并运行烘焙**

Run: `node --check scripts/bake-roles.js && node scripts/bake-roles.js`
Expected: 输出 5 行 bake 日志 + `done.`，无异常；`assets/characters/` 下 5 个 GLB，`soldier_anims.glb` < 200KB，每个 `soldier0X.glb` < 2.5MB。若报 "贴图重采样失败：需要 python + Pillow"，先 `pip install pillow` 再重跑。

- [ ] **Step 4: 核对产物体积**

Run: `ls -la assets/characters/`
Expected: 总大小约 5~7MB（原始 44MB）。若 `soldier02~04.glb` 仍 >5MB，说明重采样没生效，回到 Step 3 查 Pillow 报错。

- [ ] **Step 5: Commit**

```bash
git add scripts/bake-roles.js scripts/lib/resize_png.py assets/characters/
git commit -m "feat(assets): 体素角色烘焙管线与产物（44MB→约6MB）"
```

---

### Task 2: `js/soldier.js` — 皮肤分发层与公共枪构建

**Files:**
- Modify: `js/soldier.js`（`addGun` 约 298-374 行、`createClassSoldier` 约 780-802 行、`createPreviewSoldier` 约 1844-1854 行、`updateLocomotion` 约 1778-1782 行、导出表约 1856-1876 行）
- Modify: `index.html:1501`（`js/soldier.js?v=` 令牌）

**Interfaces:**
- Consumes: 无（为 Task 3 铺路）。
- Produces:
  - `VF.Soldier.buildGunProp(style, muzzleZ)` → `{gun, muzzle, flash}`：**只造枪体**（无手臂、不摆位、不挂到 root），`gun` 是 `THREE.Group`，`name='Weapon'`，内含 `Muzzle` / `MuzzleFlash` 节点。
  - `VF.Soldier.getPlayerSkinId()` → `'box' | 'voxel01'..'voxel04'`
  - `VF.Soldier.setPlayerSkinId(id)` → void
  - `createClassSoldier(classId, opts)` / `createPreviewSoldier(classId, opts)` 的 `opts` 新增 `skinId` 字段；`updateLocomotion` 对 `root.userData.glbAnim` 的根委托给 `VF.SoldierVoxel.drive`。

注意：`addGun` 目前把**盒子手臂**（`GunRightHand` / `GunLeftHand`）也造在枪上并负责摆位（`gun.position.set(0.18, 1.22, -0.35)`）。体素角色只需要枪体（背挂），所以把枪体构造提出来，手臂与摆位留在 `addGun` 原处，盒子兵行为一字不变。

- [ ] **Step 1: 提取 `buildGunProp`**

把 `js/soldier.js` 中 `addGun` 函数（`function addGun(root, style, muzzleZ) {` 开头）改为下面这样——枪体 boxes 与 muzzle/flash 移入新函数 `buildGunProp`，`addGun` 调用它再补手臂与摆位：

```js
  /**
   * 只造枪体（无手臂、不摆位、不挂 root）。盒子兵由 addGun 补手臂；
   * 体素角色（soldier-voxel.js）拿它做背部挂枪。
   */
  function buildGunProp(style, muzzleZ) {
    const gun = new THREE.Group();
    gun.name = 'Weapon';
    const g = PALETTE.gun;
    const gd = PALETTE.gunDark;
    const wood = 0x8a5a32;
    const accent = PALETTE.orange;
    const vest = PALETTE.vest;

    if (style === 'heavy') {
      gun.add(box(0.18, 0.18, 0.55, g, 0, 0.02, -0.05));
      gun.add(box(0.14, 0.14, 0.55, gd, 0, 0.02, -0.55));
      gun.add(box(0.1, 0.1, 0.28, gd, 0, 0.02, -0.95));
      gun.add(box(0.16, 0.28, 0.14, gd, 0, -0.16, 0.05));
      gun.add(box(0.2, 0.14, 0.28, wood, 0, 0, 0.32));
      gun.add(box(0.12, 0.12, 0.22, accent, 0, -0.16, -0.2));
      gun.add(box(0.1, 0.1, 0.2, vest, 0, 0.16, -0.1));
      gun.add(box(0.08, 0.08, 0.08, 0x1a1a1a, 0, 0.24, -0.1));
    } else if (style === 'sniper') {
      gun.add(box(0.11, 0.12, 0.7, g, 0, 0.02, -0.15));
      gun.add(box(0.08, 0.08, 0.7, gd, 0, 0.02, -0.8));
      gun.add(box(0.09, 0.2, 0.12, gd, 0, -0.12, 0.05));
      gun.add(box(0.14, 0.12, 0.28, wood, 0, 0, 0.35));
      gun.add(box(0.1, 0.1, 0.28, vest, 0, 0.16, -0.2));
      gun.add(box(0.06, 0.06, 0.1, 0x111111, 0, 0.24, -0.2));
    } else {
      // Assault rifle — full stock → muzzle for third-person / AI
      gun.add(box(0.14, 0.12, 0.26, wood, 0, 0.02, 0.32));
      gun.add(box(0.13, 0.14, 0.5, g, 0, 0.02, -0.05));
      gun.add(box(0.11, 0.08, 0.32, accent, 0, -0.02, -0.05));
      gun.add(box(0.11, 0.11, 0.42, gd, 0, 0.02, -0.48));
      gun.add(box(0.07, 0.07, 0.32, gd, 0, 0.02, -0.85));
      gun.add(box(0.09, 0.09, 0.1, g, 0, 0.02, -1.02));
      gun.add(box(0.1, 0.2, 0.12, gd, 0, -0.12, 0.08));
      gun.add(box(0.12, 0.16, 0.14, accent, 0, -0.16, -0.1));
      gun.add(box(0.09, 0.06, 0.28, gd, 0, 0.12, -0.1));
      gun.add(box(0.1, 0.1, 0.16, vest, 0, 0.18, -0.08));
      gun.add(box(0.06, 0.06, 0.08, 0x222222, 0, 0.26, -0.08));
    }

    const muzzle = new THREE.Object3D();
    muzzle.name = 'Muzzle';
    muzzle.position.set(0, 0.02, muzzleZ != null ? muzzleZ : -1.05);
    gun.add(muzzle);
    const flash = new THREE.Object3D();
    flash.name = 'MuzzleFlash';
    muzzle.add(flash);
    return { gun, muzzle, flash };
  }

  function addGun(root, style, muzzleZ) {
    const built = buildGunProp(style, muzzleZ);
    const gun = built.gun;

    // Hands + forearms parented to gun (survive finishSoldier facing wrap)
    const skin = PALETTE.skin;
    const sleeve = PALETTE.olive;
    const glove = PALETTE.glove;
    const rh = new THREE.Group();
    rh.name = 'GunRightHand';
    rh.add(box(0.14, 0.14, 0.14, skin, 0, 0, 0));
    rh.add(box(0.12, 0.1, 0.16, glove, 0, -0.02, 0.02));
    rh.add(box(0.18, 0.18, 0.32, skin, 0.04, 0.02, 0.22));
    rh.add(box(0.2, 0.2, 0.28, sleeve, 0.06, 0.06, 0.48));
    rh.position.set(0.04, -0.18, 0.08);
    rh.rotation.set(0.15, 0.1, -0.2);
    gun.add(rh);

    const lh = new THREE.Group();
    lh.name = 'GunLeftHand';
    lh.add(box(0.13, 0.13, 0.13, skin, 0, 0, 0));
    lh.add(box(0.11, 0.09, 0.14, glove, 0, -0.02, 0.02));
    lh.add(box(0.16, 0.16, 0.36, skin, -0.06, 0.04, 0.2));
    lh.add(box(0.18, 0.18, 0.3, sleeve, -0.1, 0.08, 0.45));
    lh.position.set(-0.04, -0.08, style === 'sniper' ? -0.5 : -0.4);
    lh.rotation.set(0.1, -0.25, 0.35);
    gun.add(lh);

    // Aim-ready: rifle at chest height, barrel forward (-Z)
    gun.position.set(0.18, 1.22, -0.35);
    gun.rotation.set(-0.2, 0.05, 0.08);

    root.add(gun);
    return built;
  }
```

- [ ] **Step 2: 加皮肤存储读写**

在 `js/soldier.js` 的 `normalizeClassId` 函数之后插入：

```js
  /* ---------- 角色形象（皮肤） ---------- */

  const SKIN_STORAGE_KEY = 'vf_soldier_skin';

  function getPlayerSkinId() {
    try {
      const v = localStorage.getItem(SKIN_STORAGE_KEY);
      if (v === 'box') return 'box';
      if (
        v &&
        global.VF.SoldierVoxel &&
        global.VF.SoldierVoxel.isValidSkin &&
        global.VF.SoldierVoxel.isValidSkin(v)
      ) {
        return v;
      }
    } catch (_) {}
    return 'box';
  }

  function setPlayerSkinId(id) {
    try {
      localStorage.setItem(SKIN_STORAGE_KEY, id || 'box');
    } catch (_) {}
  }
```

- [ ] **Step 3: `createClassSoldier` 加 skinId 分发**

把 `createClassSoldier` 的开头从：

```js
  function createClassSoldier(classId, opts) {
    opts = opts || {};
    classId = normalizeClassId(classId);
    const team = opts.team === 'enemy' ? 'enemy' : 'ally';
```

改为：

```js
  function createClassSoldier(classId, opts) {
    opts = opts || {};
    classId = normalizeClassId(classId);
    const team = opts.team === 'enemy' ? 'enemy' : 'ally';
    const skinId = opts.skinId || 'box';
    if (
      skinId !== 'box' &&
      global.VF.SoldierVoxel &&
      global.VF.SoldierVoxel.isReady(skinId)
    ) {
      const voxel = global.VF.SoldierVoxel.create(skinId, {
        classId: classId,
        team: team,
      });
      if (voxel) return voxel;
      // 创建失败静默回退盒子兵
    }
```

（函数其余部分不变。）

- [ ] **Step 4: `createPreviewSoldier` 透传 skinId**

把：

```js
  function createPreviewSoldier(classId, opts) {
    const root = createClassSoldier(classId, {
      team: resolveFactionTeam(opts && opts.team),
    });
```

改为：

```js
  function createPreviewSoldier(classId, opts) {
    const root = createClassSoldier(classId, {
      team: resolveFactionTeam(opts && opts.team),
      skinId: opts && opts.skinId,
    });
```

- [ ] **Step 5: `updateLocomotion` 加 glbAnim 分支**

把 `updateLocomotion` 开头从：

```js
  function updateLocomotion(root, dt, state) {
    if (!root) return;
    const loco = root.userData.loco || initLocomotion(root);
```

改为：

```js
  function updateLocomotion(root, dt, state) {
    if (!root) return;
    // 体素骨骼角色：走 AnimationMixer 驱动（见 js/soldier-voxel.js）。
    // 必须分支在 initLocomotion 之前——否则盒子兵的腿部摆动逻辑会找到
    // 背挂的 Weapon 并和 mixer 抢着改它的变换。
    if (
      root.userData.glbAnim &&
      global.VF.SoldierVoxel &&
      global.VF.SoldierVoxel.drive
    ) {
      global.VF.SoldierVoxel.drive(root, dt, state);
      return;
    }
    const loco = root.userData.loco || initLocomotion(root);
```

- [ ] **Step 6: 导出表补三项**

在 `global.VF.Soldier = {` 的导出列表中，`createSoldier,` 之后加入：

```js
    buildGunProp,
    getPlayerSkinId,
    setPlayerSkinId,
```

- [ ] **Step 7: bump 缓存令牌**

`index.html` 中：
- `<script src="js/soldier.js?v=faction-mesh1"></script>` → `<script src="js/soldier.js?v=voxelskin1"></script>`

- [ ] **Step 8: 验证**

Run: `node --check js/soldier.js`
Expected: 无输出（语法通过）。

Run: 起本地服务（`python -m http.server 8765`，另开终端），浏览器开 `http://127.0.0.1:8765/`，进部署页。
Expected: 控制台无报错；`VF.Soldier.getPlayerSkinId()` 返回 `'box'`；兵种预览与改动前完全一致（`createClassSoldier` 默认路径未被触碰）。

- [ ] **Step 9: Commit**

```bash
git add js/soldier.js index.html
git commit -m "feat(soldier): 皮肤分发层 + buildGunProp 公共枪构建"
```

---

### Task 3: `js/soldier-voxel.js` — 体素角色运行时模块

**Files:**
- Create: `js/soldier-voxel.js`
- Modify: `index.html:1501`（在 soldier.js 之后插入新 script 标签）
- Consumes: `assets/characters/*.glb`（Task 1 产物）；`VF.Soldier.buildGunProp`（Task 2）
- Produces: `VF.SoldierVoxel = { SKINS, isValidSkin, isReady, preload, preloadAll, create, drive }`

**Interfaces:**
- `VF.SoldierVoxel.SKINS` → `[{id:'voxel01', nameZh, file:'soldier01.glb'}, …]`
- `VF.SoldierVoxel.isValidSkin(id)` → bool
- `VF.SoldierVoxel.isReady(id)` → bool（动作库 + 该皮肤均已加载成功）
- `VF.SoldierVoxel.preload(id)` → `Promise<bool>`（失败态同样缓存，不重试）
- `VF.SoldierVoxel.preloadAll()` → `Promise<bool[]>`
- `VF.SoldierVoxel.create(id, {classId, team})` → root 或 null。root 结构与盒子兵同构：`SoldierFacing` 包装（`rotation.y=π`）、`TeamMarker`、`userData.{glbAnim,muzzle,variant,classId,team}`
- `VF.SoldierVoxel.drive(root, dt, state)`，`state = {moving, speedRatio, onGround}`，与盒子兵 `updateLocomotion` 契约一致

- [ ] **Step 1: 写 `js/soldier-voxel.js`**

完整内容：

```js
/**
 * soldier-voxel.js — 体素角色（Soldier01–04，UE5 导出的 Bip001 骨架 GLB）
 *
 * 与盒子士兵（VF.Soldier）接口对齐，作为玩家可选外观（皮肤）：
 * - VF.SoldierVoxel.SKINS                   皮肤元数据
 * - VF.SoldierVoxel.preload(id)             懒加载单个皮肤（含动作库）
 * - VF.SoldierVoxel.isReady(id)
 * - VF.SoldierVoxel.create(id, {classId, team})  克隆出一个骨骼角色
 * - VF.SoldierVoxel.drive(root, dt, state)  由 VF.Soldier.updateLocomotion 委托
 *
 * 资产约定（烘焙产物，见 scripts/bake-roles.js）：
 * - assets/characters/soldier01..04.glb   蒙皮网格，共用同一副 Bip001 骨架
 * - assets/characters/soldier_anims.glb   Walk / Run / Pick 三个 clip
 *   四个角色骨架同名同构，动作 track 按节点名寻址，直接套用，无 retarget。
 * - 模型原生面朝 +Z（脚趾相对脚踝在 +Z 侧），与盒子兵一致 → SoldierFacing
 *   沿用 rotation.y = π。
 *
 * 动作只有 Walk(1.2s) / Run(0.8s) / Pick(1.6s) 三个，都是原地动画：
 * - 待机 = Pick 第 0 帧冻结（绑定姿势是 A-pose 摊手，不可用；
 *   Pick 首尾同姿势且第 0 帧双脚落平、手臂自然下垂——FK 解算验证过）
 * - 呼吸 = mixer.update 之后给 Bip001-Spine1 叠极慢正弦
 * - 开火 / 蹲 / 死亡没有动作资产，不做任何动画响应（资产限制，不是取舍）
 */
(function (global) {
  'use strict';

  const CHAR_DIR = 'assets/characters/';
  const ANIMS_URL = CHAR_DIR + 'soldier_anims.glb';

  const SKINS = [
    { id: 'voxel01', nameZh: '体素兵 01', file: 'soldier01.glb' },
    { id: 'voxel02', nameZh: '体素兵 02', file: 'soldier02.glb' },
    { id: 'voxel03', nameZh: '体素兵 03', file: 'soldier03.glb' },
    { id: 'voxel04', nameZh: '体素兵 04', file: 'soldier04.glb' },
  ];

  const IDLE_CLIP = 'Pick';
  const IDLE_TIME = 0;
  const WALK_CLIP = 'Walk';
  const RUN_CLIP = 'Run';
  const RUN_THRESHOLD = 0.85; // speedRatio 达到此值播 Run，否则 Walk
  const HYSTERESIS = 0.12; // 走/停 120ms 滞回，防止边界每帧互切

  const BREATHE_BONE = 'Bip001-Spine1';
  const BREATHE_HZ = 0.25; // 约 4s 一个周期
  const BREATHE_AMP = 0.015; // rad

  let _anims = null; // { clips: {Walk, Run, Pick} }
  let _animsPromise = null;
  const _skins = {}; // id -> { gltf }
  const _skinPromises = {}; // id -> Promise<bool>（失败态同样缓存）

  function isValidSkin(id) {
    return SKINS.some((s) => s.id === id);
  }

  function isReady(id) {
    return !!_anims && !!(_skins[id] && _skins[id].gltf);
  }

  function _loadGltf(url) {
    return new Promise((resolve) => {
      if (!global.THREE || !THREE.GLTFLoader) {
        console.warn('[SoldierVoxel] GLTFLoader 不可用');
        resolve(null);
        return;
      }
      new THREE.GLTFLoader().load(url, resolve, undefined, (err) => {
        console.warn('[SoldierVoxel] 加载失败:', url, (err && err.message) || err);
        resolve(null);
      });
    });
  }

  function preloadAnims() {
    if (_animsPromise) return _animsPromise;
    _animsPromise = _loadGltf(ANIMS_URL).then((gltf) => {
      if (!gltf || !gltf.animations || !gltf.animations.length) return false;
      const clips = {};
      gltf.animations.forEach((c) => {
        clips[c.name] = c;
      });
      if (!clips[WALK_CLIP] || !clips[RUN_CLIP] || !clips[IDLE_CLIP]) {
        console.warn('[SoldierVoxel] 动作库缺 clip:', Object.keys(clips).join(','));
        return false;
      }
      _anims = { clips: clips };
      console.log('[SoldierVoxel] 动作库就绪:', Object.keys(clips).join(', '));
      return true;
    });
    return _animsPromise;
  }

  function preload(id) {
    if (!isValidSkin(id)) return Promise.resolve(false);
    if (_skinPromises[id]) return _skinPromises[id];
    const meta = SKINS.find((s) => s.id === id);
    _skinPromises[id] = Promise.all([
      preloadAnims(),
      _loadGltf(CHAR_DIR + meta.file),
    ]).then((results) => {
      const ok = !!(results[0] && results[1]);
      if (ok) {
        _skins[id] = { gltf: results[1] };
        console.log('[SoldierVoxel] 皮肤就绪:', id);
      }
      return ok;
    });
    return _skinPromises[id];
  }

  function preloadAll() {
    return Promise.all(SKINS.map((s) => preload(s.id)));
  }

  /* ---------- 背部挂枪 ---------- */

  // 挂在脊椎后方的 Dummy001 挂点（模型网格不含武器）。
  // 朝向推导：wrap(rotation.y=π) 之后模型的"背后"是世界 +Z；
  // 让枪背(+Y)朝世界 +Z、枪管(-Z)朝世界 +Y——即枪管朝上斜背在身后。
  function _mountBackWeapon(model, wrap) {
    if (!global.VF.Soldier || !global.VF.Soldier.buildGunProp) return null;
    const socket = model.getObjectByName('Dummy001');
    if (!socket) return null;
    wrap.updateMatrixWorld(true);
    const built = global.VF.Soldier.buildGunProp('rifle', -0.85);
    const gun = built.gun;
    const desired = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.PI / 2, 0, 0)
    );
    const socketQ = new THREE.Quaternion();
    socket.getWorldQuaternion(socketQ);
    const inv = socketQ.clone().invert();
    // gun.quaternion 满足 socketQ * gun.quaternion = desired
    gun.quaternion.copy(inv.clone().multiply(desired));
    // 往背外挪一点避免穿模（世界方向 → socket 局部）
    const out = new THREE.Vector3(0, 0.02, 0.14).applyQuaternion(inv);
    gun.position.copy(out);
    socket.add(gun);
    return built;
  }

  function _addTeamMarker(root, team) {
    const L = global.VF && global.VF.TeamLook;
    const foe = L && L.kind ? L.kind(team) === 'foe' : team === 'enemy';
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.55, 16),
      new THREE.MeshBasicMaterial({
        color: foe ? 0xff3344 : 0x33aaff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
      })
    );
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = 0.05;
    marker.name = 'TeamMarker';
    marker.userData.faction = team;
    root.add(marker);
  }

  /* ---------- 创建 ---------- */

  function create(id, opts) {
    if (!isReady(id)) return null;
    opts = opts || {};
    const classId = opts.classId || 'assault';
    const team = opts.team === 'enemy' ? 'enemy' : 'ally';

    const src = _skins[id].gltf;
    const model =
      THREE.SkeletonUtils && THREE.SkeletonUtils.clone
        ? THREE.SkeletonUtils.clone(src.scene)
        : src.scene.clone(true);
    model.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.frustumCulled = false; // 蒙皮动画后包围盒失效，关掉剔除防闪没
      }
    });

    const wrap = new THREE.Group();
    wrap.name = 'SoldierFacing';
    wrap.rotation.y = Math.PI;
    wrap.add(model);

    const root = new THREE.Group();
    root.name = 'SoldierVoxel_' + classId;
    root.add(wrap);

    let muzzle = null;
    const gunBits = _mountBackWeapon(model, wrap);
    if (gunBits) muzzle = gunBits.muzzle;

    _addTeamMarker(root, team);

    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    Object.keys(_anims.clips).forEach((name) => {
      actions[name] = mixer.clipAction(_anims.clips[name]);
    });
    // 待机：冻结 Pick 第 0 帧
    const idle = actions[IDLE_CLIP];
    if (idle) {
      idle.play();
      idle.time = IDLE_TIME;
      idle.paused = true;
    }

    root.userData.glbAnim = {
      mixer: mixer,
      actions: actions,
      current: idle || null,
      breatheBone: model.getObjectByName(BREATHE_BONE),
      breatheBaseX: null,
      time: 0,
      motionState: 'idle',
      motionCandidate: null,
      motionCandidateTime: 0,
    };
    root.userData.muzzle = muzzle;
    root.userData.variant = classId;
    root.userData.classId = classId;
    root.userData.team = team;
    root.frustumCulled = false;
    return root;
  }

  /* ---------- 动画驱动 ---------- */

  function drive(root, dt, state) {
    const a = root.userData.glbAnim;
    if (!a) return;
    state = state || {};
    dt = dt || 0.016;
    const onGround = state.onGround !== false;
    const sr =
      state.speedRatio != null ? state.speedRatio : state.moving ? 1 : 0;
    const moving = !!state.moving && sr > 0.08 && onGround;

    let want = 'idle';
    if (moving) want = sr >= RUN_THRESHOLD ? 'run' : 'walk';

    // 滞回（与盒子兵同款边界抖动问题）
    if (want !== a.motionState) {
      if (a.motionCandidate !== want) {
        a.motionCandidate = want;
        a.motionCandidateTime = 0;
      } else {
        a.motionCandidateTime += dt;
      }
      if (a.motionCandidateTime >= HYSTERESIS) {
        a.motionState = want;
        a.motionCandidate = null;
        a.motionCandidateTime = 0;
      }
    } else {
      a.motionCandidate = null;
      a.motionCandidateTime = 0;
    }

    const clipName =
      a.motionState === 'run'
        ? RUN_CLIP
        : a.motionState === 'walk'
        ? WALK_CLIP
        : IDLE_CLIP;
    const target = a.actions[clipName];
    if (target && a.current !== target) {
      const prev = a.current;
      target.reset().fadeIn(0.18).play();
      target.timeScale = 0.7 + Math.min(1.2, sr) * 0.5;
      if (prev) prev.fadeOut(0.18);
      a.current = target;
      if (a.motionState === 'idle') {
        target.time = IDLE_TIME;
        target.paused = true;
      }
    }

    // 呼吸：仅待机时叠加在胸椎。必须在 mixer.update 之后写，
    // 否则下一帧 clip 采样会把它覆盖掉。
    a.time += dt;
    a.mixer.update(dt);
    if (a.breatheBone) {
      if (a.breatheBaseX == null) a.breatheBaseX = a.breatheBone.rotation.x;
      if (a.motionState === 'idle') {
        a.breatheBone.rotation.x =
          a.breatheBaseX +
          Math.sin(a.time * Math.PI * 2 * BREATHE_HZ) * BREATHE_AMP;
      }
    }
  }

  global.VF = global.VF || {};
  global.VF.SoldierVoxel = {
    SKINS: SKINS,
    isValidSkin: isValidSkin,
    isReady: isReady,
    preload: preload,
    preloadAll: preloadAll,
    create: create,
    drive: drive,
  };

  // 动作库只有 ~80KB，启动即预载；皮肤按需（部署页打开时 preloadAll）
  preloadAnims();
})(window);
```

- [ ] **Step 2: 接入 index.html**

`index.html` 中，把：

```html
  <script src="js/soldier.js?v=voxelskin1"></script>
```

改为：

```html
  <script src="js/soldier.js?v=voxelskin1"></script>
  <script src="js/soldier-voxel.js?v=voxelskin1"></script>
```

（必须在 `js/soldier.js` 之后、`js/player.js` 之前。）

- [ ] **Step 3: 验证**

Run: `node --check js/soldier-voxel.js`
Expected: 无输出。

Run: 浏览器开 `http://127.0.0.1:8765/`（本地服务），控制台执行：
```js
await VF.SoldierVoxel.preloadAll()
```
Expected: 输出 `[true,true,true,true]`；控制台有 `[SoldierVoxel] 动作库就绪: Walk, Run, Pick` 与四条 `皮肤就绪`。再执行：
```js
var m = VF.SoldierVoxel.create('voxel01', {classId:'assault', team:'ally'});
[m.name, !!m.getObjectByName('SoldierFacing'), !!m.getObjectByName('TeamMarker'), !!m.getObjectByName('Weapon'), !!m.userData.glbAnim]
```
Expected: `["SoldierVoxel_assault", true, true, true, true]`。

（视觉验证在 Task 7 统一做；这里只验证加载与结构。）

- [ ] **Step 4: Commit**

```bash
git add js/soldier-voxel.js index.html
git commit -m "feat(soldier): 体素角色运行时模块（加载/创建/动画驱动）"
```

---

### Task 4: 部署页"角色形象"选择器

**Files:**
- Modify: `index.html`（`class-deploy-footer` 区域，约 906-908 行）
- Modify: `style.css`（文件末尾追加）
- Modify: `js/ui.js`（els 约 209 行、`openClassSelect` 约 3139 行、`_buildClassGrid` 之后新增方法、`_startClassPreviews` 约 3434-3456 行、`_startLoadoutCustomizePreview` 约 3835-3847 行、`index.html` 的 `js/ui.js?v=` 与 `style.css?v=` 令牌）
- Consumes: `VF.Soldier.getPlayerSkinId / setPlayerSkinId`（Task 2）、`VF.SoldierVoxel.*`（Task 3）
- Produces: 部署页底部出现"角色形象"行；`UI._buildSkinGrid / _startSkinPreload / _selectSkin / _refreshClassStageSkin / _bakeSkinAvatars` 五个方法

- [ ] **Step 1: index.html 加选择器行**

`index.html` 的 `class-deploy-footer` 中，把：

```html
        <span class="class-deploy-select-label">选择兵种</span>
        <div class="class-list" id="class-grid"></div>
```

改为：

```html
        <span class="class-deploy-select-label">选择兵种</span>
        <div class="class-list" id="class-grid"></div>
        <span class="class-deploy-select-label class-skin-label">角色形象</span>
        <div class="class-skin-list" id="class-skin-grid"></div>
```

- [ ] **Step 2: style.css 末尾追加样式**

`style.css` 文件末尾追加：

```css
/* ---------- 角色形象选择器（体素皮肤） ---------- */
.class-skin-label {
  margin-top: 10px;
}
.class-skin-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}
.class-skin-list .class-skin-card {
  width: 84px;
}
.class-skin-list .class-skin-card.is-loading .class-avatar {
  opacity: 0.35;
}
.class-skin-list .class-skin-card.is-disabled {
  opacity: 0.35;
  pointer-events: none;
}
```

- [ ] **Step 3: ui.js els 注册 skinGrid**

`js/ui.js` 中 els 初始化处（约 209 行），把：

```js
        classGrid: document.getElementById('class-grid'),
```

改为：

```js
        classGrid: document.getElementById('class-grid'),
        skinGrid: document.getElementById('class-skin-grid'),
```

- [ ] **Step 4: openClassSelect 接入**

`js/ui.js` 的 `openClassSelect` 中（约 3139 行），把：

```js
      this._buildClassGrid();
      this._bindClassSelect();
```

改为：

```js
      this._buildClassGrid();
      this._buildSkinGrid();
      this._startSkinPreload();
      this._bindClassSelect();
```

- [ ] **Step 5: ui.js 新增五个方法**

紧接 `_buildClassGrid` 方法的结束 `},` 之后，插入：

```js
    /* ---------- 角色形象（皮肤）选择 ---------- */

    _buildSkinGrid() {
      const grid = this.els.skinGrid;
      if (!grid) return;
      grid.innerHTML = '';
      const current =
        global.VF.Soldier && global.VF.Soldier.getPlayerSkinId
          ? global.VF.Soldier.getPlayerSkinId()
          : 'box';
      const skins = [{ id: 'box', nameZh: '原型兵' }].concat(
        (global.VF.SoldierVoxel && global.VF.SoldierVoxel.SKINS) || []
      );
      skins.forEach((s) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'class-card class-skin-card';
        btn.dataset.skinId = s.id;
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 96;
        canvas.className = 'class-avatar';
        canvas.dataset.skinId = s.id;
        const name = document.createElement('span');
        name.className = 'class-card-name';
        name.textContent = s.nameZh;
        btn.appendChild(canvas);
        btn.appendChild(name);
        if (s.id !== 'box') btn.classList.add('is-loading');
        btn.classList.toggle('selected', s.id === current);
        btn.setAttribute('aria-pressed', s.id === current ? 'true' : 'false');
        btn.addEventListener('click', () => this._selectSkin(s.id));
        grid.appendChild(btn);
      });
      this._bakeSkinAvatars();
    },

    _startSkinPreload() {
      const V = global.VF.SoldierVoxel;
      if (!V || !V.SKINS) return;
      V.SKINS.forEach((s) => {
        V.preload(s.id).then((ok) => {
          const grid = this.els.skinGrid;
          const btn = grid
            ? grid.querySelector('button[data-skin-id="' + s.id + '"]')
            : null;
          if (!ok) {
            if (btn) {
              btn.classList.remove('is-loading');
              btn.classList.add('is-disabled');
              btn.title = '角色资源加载失败';
            }
            return;
          }
          if (btn) btn.classList.remove('is-loading');
          // 当前选中的皮肤刚刚就绪 → 重建站台模型换上它
          if (
            global.VF.Soldier &&
            global.VF.Soldier.getPlayerSkinId &&
            global.VF.Soldier.getPlayerSkinId() === s.id
          ) {
            this._refreshClassStageSkin();
          }
          this._bakeSkinAvatars();
        });
      });
    },

    _selectSkin(id) {
      const V = global.VF.SoldierVoxel;
      if (id !== 'box' && (!V || !V.isReady(id))) return; // 未就绪不可选
      if (global.VF.Soldier && global.VF.Soldier.setPlayerSkinId) {
        global.VF.Soldier.setPlayerSkinId(id);
      }
      const grid = this.els.skinGrid;
      if (grid) {
        grid.querySelectorAll('.class-skin-card').forEach((el) => {
          const on = el.dataset.skinId === id;
          el.classList.toggle('selected', on);
          el.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      }
      this._refreshClassStageSkin();
      this._bakeSkinAvatars();
    },

    _refreshClassStageSkin() {
      const prev = this._classPreview;
      if (!prev || !global.VF.Soldier) return;
      const classes = global.VF.Soldier.CLASSES || [];
      const skinId = global.VF.Soldier.getPlayerSkinId
        ? global.VF.Soldier.getPlayerSkinId()
        : 'box';
      const previewTeam = this._playerTeam() === 'enemy' ? 'enemy' : 'ally';
      for (const k in prev.models) {
        if (prev.models[k] && prev.scene) prev.scene.remove(prev.models[k]);
      }
      prev.models = {};
      for (let i = 0; i < classes.length; i++) {
        const m = global.VF.Soldier.createPreviewSoldier(classes[i].id, {
          team: previewTeam,
          skinId: skinId,
        });
        m.visible = false;
        if (global.VF.Soldier.initLocomotion) global.VF.Soldier.initLocomotion(m);
        prev.scene.add(m);
        prev.models[classes[i].id] = m;
      }
      this._bakeClassAvatars();
    },

    _bakeSkinAvatars() {
      const prev = this._classPreview;
      const grid = this.els.skinGrid;
      if (!prev || !grid || !global.VF.Soldier) return;
      const V = global.VF.SoldierVoxel;
      if (!prev.skinModels) prev.skinModels = {};
      const previewTeam = this._playerTeam() === 'enemy' ? 'enemy' : 'ally';
      const size = 96;
      prev.renderer.setSize(size, size, false);
      prev.headCam.aspect = 1;
      prev.headCam.updateProjectionMatrix();

      const hideAll = () => {
        for (const k in prev.models) prev.models[k].visible = false;
        for (const k in prev.skinModels) prev.skinModels[k].visible = false;
      };
      const bake = (skinId, model) => {
        const canvas = grid.querySelector(
          'canvas[data-skin-id="' + skinId + '"]'
        );
        if (!canvas || !model) return;
        hideAll();
        model.visible = true;
        model.rotation.y = Math.PI + 0.15;
        model.position.set(0, 0, 0);
        prev.renderer.render(prev.scene, prev.headCam);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(
            prev.renderer.domElement,
            0,
            0,
            canvas.width,
            canvas.height
          );
        }
        model.visible = false;
      };

      // 原型兵：直接借 assault 的盒子模型烘头像
      if (prev.models && prev.models.assault) bake('box', prev.models.assault);
      if (V && V.SKINS) {
        V.SKINS.forEach((s) => {
          if (!V.isReady(s.id)) return;
          if (!prev.skinModels[s.id]) {
            const m = V.create(s.id, { classId: 'assault', team: previewTeam });
            if (!m) return;
            m.visible = false;
            prev.scene.add(m);
            prev.skinModels[s.id] = m;
          }
          bake(s.id, prev.skinModels[s.id]);
        });
      }
    },
```

- [ ] **Step 6: 两处预览构造传 skinId**

`_startClassPreviews` 的模型构造（约 3437 行），把：

```js
        const m = global.VF.Soldier.createPreviewSoldier(classes[i].id, {
          team: previewTeam,
        });
```

改为：

```js
        const m = global.VF.Soldier.createPreviewSoldier(classes[i].id, {
          team: previewTeam,
          skinId: global.VF.Soldier.getPlayerSkinId
            ? global.VF.Soldier.getPlayerSkinId()
            : 'box',
        });
```

同方法中 `this._bakeClassAvatars();`（约 3455 行）之后加一行：

```js
      this._bakeSkinAvatars();
```

`_startLoadoutCustomizePreview` 的模型构造（约 3836 行），把：

```js
        const model = global.VF.Soldier.createPreviewSoldier(classes[i].id, {
          team: previewTeam,
        });
```

改为：

```js
        const model = global.VF.Soldier.createPreviewSoldier(classes[i].id, {
          team: previewTeam,
          skinId: global.VF.Soldier.getPlayerSkinId
            ? global.VF.Soldier.getPlayerSkinId()
            : 'box',
        });
```

- [ ] **Step 7: bump 缓存令牌**

`index.html` 中：
- `<link rel="stylesheet" href="style.css?v=mgoptic3" />` → `<link rel="stylesheet" href="style.css?v=voxelskin1" />`
- `<script src="js/ui.js?v=navigation2"></script>` → `<script src="js/ui.js?v=voxelskin1"></script>`

- [ ] **Step 8: 验证**

Run: `node --check js/ui.js`
Expected: 无输出。

Run: 浏览器进部署页。
Expected: 底部出现"角色形象"一行 5 个按钮（原型兵 + 体素兵 01~04）；体素按钮加载完成后出现头像缩略图；点击"体素兵 01"，中间站台模型换成骨骼角色（站姿自然、背上有枪）；刷新页面后选中态保持；控制台无报错。

- [ ] **Step 9: Commit**

```bash
git add index.html style.css js/ui.js
git commit -m "feat(ui): 部署页角色形象选择器"
```

---

### Task 5: 其余展示位接线（出击演出 + PvP 同步屏预览）

**Files:**
- Modify: `js/deployment-presentation.js:275-279`（小队预览模型构造）
- Modify: `js/pvp.js:2150-2166`（`_makePreviewModel`）
- Modify: `index.html`（`js/deployment-presentation.js?v=` 与 `js/pvp.js?v=` 令牌）
- Consumes: `VF.Soldier.getPlayerSkinId`（Task 2）、`createPreviewSoldier/createClassSoldier` 的 `skinId` 参数（Task 2/3）

- [ ] **Step 1: 小队出击演出——只有玩家本人用皮肤**

`js/deployment-presentation.js` 的模型构造循环中，把：

```js
        const model = global.VF.Soldier.createPreviewSoldier(
          member.classId || 'assault',
          { team: previewTeam }
        );
```

改为：

```js
        const model = global.VF.Soldier.createPreviewSoldier(
          member.classId || 'assault',
          {
            team: previewTeam,
            skinId:
              member.isPlayer && global.VF.Soldier.getPlayerSkinId
                ? global.VF.Soldier.getPlayerSkinId()
                : 'box',
          }
        );
```

（roster 里 `member.isPlayer` 标记玩家本人；AI 队友保持盒子兵。）

- [ ] **Step 2: PvP 同步屏预览**

`js/pvp.js` 的 `_makePreviewModel` 中，把：

```js
      if (Soldier.createClassSoldier) {
        m = Soldier.createClassSoldier(classId || 'assault', {
          team: team || 'ally',
        });
      } else {
```

改为：

```js
      if (Soldier.createClassSoldier) {
        m = Soldier.createClassSoldier(classId || 'assault', {
          team: team || 'ally',
          skinId:
            (Soldier.getPlayerSkinId && Soldier.getPlayerSkinId()) || 'box',
        });
      } else {
```

- [ ] **Step 3: bump 缓存令牌**

`index.html` 中：
- `<script src="js/deployment-presentation.js?v=original-art1"></script>` → `<script src="js/deployment-presentation.js?v=voxelskin1"></script>`
- `<script src="js/pvp.js?v=faction-mesh1"></script>` → `<script src="js/pvp.js?v=voxelskin1"></script>`

- [ ] **Step 4: 验证**

Run: `node --check js/deployment-presentation.js && node --check js/pvp.js`
Expected: 无输出。

Run: 浏览器选一个体素角色后开一局单人游戏，观察小队集结画面。
Expected: 玩家本人（is-player 卡片）是体素角色，其余 AI 队友是盒子兵；控制台无报错。

- [ ] **Step 5: Commit**

```bash
git add js/deployment-presentation.js js/pvp.js index.html
git commit -m "feat(presentation): 出击演出与PvP同步屏接入角色皮肤"
```

---

### Task 6: 联机同步——对手屏幕上的你

**Files:**
- Modify: `js/main.js:1710-1717`（`openPvpSpawnGate` 的 loadout 组装）
- Modify: `js/pvp.js`（`_busPublish` 约 397-401 行、play-state 接收处约 818-824 行、`_sanitizeRemoteLoadout` 约 1928-1966 行、`ensureRemoteAvatar` 约 2717-2752 行）
- Modify: `index.html`（`js/main.js?v=` 令牌）
- Consumes: `VF.Soldier.getPlayerSkinId`（Task 2）、`VF.SoldierVoxel.SKINS / isReady / preload`（Task 3）

机制：loadout 载荷加 `skinId` 字段，随现有三条通道走——`spawnReady` 消息（自动带，因为直接发 `this.localLoadout`）、BroadcastChannel bus 槽位（需在 `_busPublish` 显式加一行）、play-state 接收处的 loadout 重建（需保留旧 skinId，否则会被 sanitize 成 `'box'` 覆盖掉 spawnReady 带来的值）。旧客户端不发该字段 → sanitize 归 `'box'` → 显示盒子兵，天然向后兼容。

- [ ] **Step 1: 发送端——loadout 组装加 skinId**

`js/main.js` 的 `openPvpSpawnGate` 中，把：

```js
    const loadout = {
      classId: game.playerClass || (game.player && game.player.classId) || 'assault',
      weaponId:
        game.preferredWeaponId ||
        (game.weapons && game.weapons.current) ||
        'ar',
      spawnId: spawn && spawn.id,
      team: game.world._playerTeam,
    };
```

改为：

```js
    const loadout = {
      classId: game.playerClass || (game.player && game.player.classId) || 'assault',
      weaponId:
        game.preferredWeaponId ||
        (game.weapons && game.weapons.current) ||
        'ar',
      spawnId: spawn && spawn.id,
      team: game.world._playerTeam,
      skinId:
        (VF.Soldier && VF.Soldier.getPlayerSkinId && VF.Soldier.getPlayerSkinId()) ||
        'box',
    };
```

- [ ] **Step 2: bus 槽位带 skinId**

`js/pvp.js` 的 `_busPublish` 中，把：

```js
      if (this.localLoadout) {
        slot.classId = this.localLoadout.classId;
        slot.weaponId = this.localLoadout.weaponId;
        slot.spawnId = this.localLoadout.spawnId;
        slot.team = this.localLoadout.team;
      }
```

改为：

```js
      if (this.localLoadout) {
        slot.classId = this.localLoadout.classId;
        slot.weaponId = this.localLoadout.weaponId;
        slot.spawnId = this.localLoadout.spawnId;
        slot.team = this.localLoadout.team;
        slot.skinId = this.localLoadout.skinId;
      }
```

- [ ] **Step 3: play-state 接收处保留 skinId**

`js/pvp.js` 约 818 行，把：

```js
          this.remoteLoadout = this._sanitizeRemoteLoadout({
            classId: other.classId || 'assault',
            weaponId: other.weaponId || 'ar',
            spawnId: other.spawnId || null,
            team: other.team || (this.mode === 'host' ? 'enemy' : 'ally'),
          });
```

改为：

```js
          this.remoteLoadout = this._sanitizeRemoteLoadout({
            classId: other.classId || 'assault',
            weaponId: other.weaponId || 'ar',
            spawnId: other.spawnId || null,
            team: other.team || (this.mode === 'host' ? 'enemy' : 'ally'),
            // bus 槽位没带 skinId 时沿用 spawnReady 送来的值，
            // 否则会被 sanitize 归 'box' 覆盖掉
            skinId:
              other.skinId ||
              (this.remoteLoadout && this.remoteLoadout.skinId) ||
              'box',
          });
```

- [ ] **Step 4: sanitizer 白名单**

`js/pvp.js` 的 `_sanitizeRemoteLoadout` 中，在 `let spawnId = loadout.spawnId || null;` 之前插入：

```js
      const validSkins = ['box'].concat(
        ((global.VF && global.VF.SoldierVoxel && global.VF.SoldierVoxel.SKINS) || []).map(
          function (s) {
            return s.id;
          }
        )
      );
      const skinId =
        validSkins.indexOf(loadout.skinId) >= 0 ? loadout.skinId : 'box';
```

并在该函数的 `return {` 对象里，`team: expectedTeam,` 之后加一行：

```js
        skinId: skinId,
```

- [ ] **Step 5: ensureRemoteAvatar 用远端皮肤 + 就绪后自动换装**

`js/pvp.js` 的 `ensureRemoteAvatar(scene)` 中，把从 `const classId =` 到 `return this.remoteAvatar;` 的缓存判定段（约 2718-2734 行）：

```js
      const classId =
        (this.remoteState && this.remoteState.classId) ||
        (this.remoteLoadout && this.remoteLoadout.classId) ||
        'assault';
      const team =
        (this.remoteState && this.remoteState.team) ||
        (this.remoteLoadout && this.remoteLoadout.team) ||
        (this.mode === 'host' ? 'enemy' : 'ally');

      if (
        this.remoteAvatar &&
        this.remoteAvatar.classId === classId &&
        this.remoteAvatar.team === team
      ) {
        return this.remoteAvatar;
      }

      this.removeRemoteAvatar(scene);
      const mesh = global.VF.Soldier.createClassSoldier(classId, { team: team });
```

改为：

```js
      const classId =
        (this.remoteState && this.remoteState.classId) ||
        (this.remoteLoadout && this.remoteLoadout.classId) ||
        'assault';
      const team =
        (this.remoteState && this.remoteState.team) ||
        (this.remoteLoadout && this.remoteLoadout.team) ||
        (this.mode === 'host' ? 'enemy' : 'ally');
      const skinId = (this.remoteLoadout && this.remoteLoadout.skinId) || 'box';
      const V = global.VF && global.VF.SoldierVoxel;
      // 体素皮肤未就绪时先用盒子兵顶上，同时触发加载；
      // 加载完成后 wantApplied 变化，下一次调用自然重建
      const wantApplied =
        skinId !== 'box' && V && V.isReady(skinId) ? skinId : 'box';
      if (skinId !== 'box' && V && !V.isReady(skinId)) {
        V.preload(skinId);
      }

      if (
        this.remoteAvatar &&
        this.remoteAvatar.classId === classId &&
        this.remoteAvatar.team === team &&
        this.remoteAvatar.appliedSkinId === wantApplied
      ) {
        return this.remoteAvatar;
      }

      this.removeRemoteAvatar(scene);
      const mesh = global.VF.Soldier.createClassSoldier(classId, {
        team: team,
        skinId: wantApplied,
      });
```

并在紧随其后的 `this.remoteAvatar = {` 对象字面量中，`team: team,` 之后加一行：

```js
        appliedSkinId: wantApplied,
```

- [ ] **Step 6: bump 缓存令牌**

`index.html` 中：
- `<script src="js/main.js?v=navigation2"></script>` → `<script src="js/main.js?v=voxelskin1"></script>`

（`js/pvp.js` 已在 Task 5 bump 过。）

- [ ] **Step 7: 验证**

Run: `node --check js/main.js && node --check js/pvp.js`
Expected: 无输出。

Run: 同机开两个浏览器窗口联机（创建房间 / 加入房间，见 index.html 底部提示"同电脑开两个窗口即可联机"），窗口 A 选体素兵 02，窗口 B 选原型兵。
Expected: B 的屏幕上 A 的化身是体素角色；A 的屏幕上 B 是盒子兵；控制台无报错。（体素模型首次加载几秒内的窗口期显示盒子兵，加载完成后自动换装——这是设计行为。）

- [ ] **Step 8: Commit**

```bash
git add js/main.js js/pvp.js index.html
git commit -m "feat(pvp): loadout 同步 skinId，远端化身用对端所选皮肤"
```

---

### Task 7: 浏览器验证脚本（截图 + 自动断言）

**Files:**
- Create: `scripts/check-roles.html`（组件级测试页，不进 diag-* 命名空间——那是 .gitignore 的草稿区）
- Create: `scripts/check-roles.js`（playwright 驱动）
- Consumes: Task 1-4 全部产物

- [ ] **Step 1: 确认 playwright 可用**

Run: `node -e "require('playwright'); console.log('playwright ok')"`
Expected: 输出 `playwright ok`。若报 `Cannot find module 'playwright'`：

```bash
npm init -y
npm i -D playwright
```

（`node_modules` 已在 .gitignore；`package.json` 是验证工具链的合法新增。）

- [ ] **Step 2: 写测试页 `scripts/check-roles.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>check-roles harness</title>
<style>html,body{margin:0;background:#16202a}canvas{display:block}</style>
</head>
<body>
<canvas id="stage" width="480" height="640"></canvas>
<script src="../js/vendor/three.gltf.global.js"></script>
<script src="../js/soldier.js"></script>
<script src="../js/soldier-voxel.js"></script>
<script>
/* 组件级测试页：不经过游戏 UI，直接驱动 VF.SoldierVoxel 渲染单个角色。
 * window.RolesCheck 由 scripts/check-roles.js 调用。 */
(function () {
  const canvas = document.getElementById('stage');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(480, 640, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x16202a);
  scene.add(new THREE.AmbientLight(0x99aabb, 0.9));
  const key = new THREE.DirectionalLight(0xfff0dd, 1.3);
  key.position.set(2, 6, 4);
  scene.add(key);
  const cam = new THREE.PerspectiveCamera(38, 480 / 640, 0.1, 40);
  cam.position.set(0, 1.1, 3.2);
  cam.lookAt(0, 0.95, 0);

  let model = null;

  function render(skinId, driveState) {
    if (model) { scene.remove(model); model = null; }
    model = VF.Soldier.createClassSoldier('assault', { team: 'ally', skinId: skinId });
    if (!model) return { ok: false, reason: 'create returned null' };
    model.rotation.y = Math.PI; // 面向镜头
    scene.add(model);
    if (driveState) {
      // 模拟 1.5 秒移动，推进动画状态机
      for (let i = 0; i < 90; i++) {
        VF.Soldier.updateLocomotion(model, 1 / 60, driveState);
      }
    } else {
      VF.Soldier.updateLocomotion(model, 1 / 60, { moving: false, speedRatio: 0, onGround: true });
    }
    renderer.render(scene, cam);
    const skinned = [];
    model.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o.name || '(unnamed)'); });
    return {
      ok: true,
      name: model.name,
      skinnedMeshes: skinned.length,
      hasWeapon: !!model.getObjectByName('Weapon'),
      hasMarker: !!model.getObjectByName('TeamMarker'),
    };
  }

  window.RolesCheck = {
    preloadAll: () => VF.SoldierVoxel.preloadAll(),
    skinIds: () => VF.SoldierVoxel.SKINS.map((s) => s.id),
    render,
  };
})();
</script>
</body>
</html>
```

- [ ] **Step 3: 写驱动脚本 `scripts/check-roles.js`**

```js
/*
 * scripts/check-roles.js — 体素角色浏览器验证
 *
 * 用法：node scripts/check-roles.js
 * 断言：
 *   1. 四个皮肤全部预载成功
 *   2. 每个皮肤 create 出蒙皮网格角色（含 Weapon / TeamMarker）
 *   3. 五张截图（box + voxel01..04）两两不同 —— 证明确实换了模型
 *   4. 移动驱动后的截图与待机截图不同 —— 证明动画真的在驱动骨骼
 * 产物：tmp/roles-check/*.png（人工复核朝向/站姿/背枪/贴图）
 */
'use strict';

const { chromium } = require('playwright');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tmp', 'roles-check');

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
    const page = await browser.newPage({ viewport: { width: 520, height: 700 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/scripts/check-roles.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.RolesCheck, null, { timeout: 15000 });

    const preloaded = await page.evaluate(() => window.RolesCheck.preloadAll());
    assert.deepEqual(preloaded, [true, true, true, true], '四个皮肤应全部预载成功');

    const skinIds = ['box'].concat(await page.evaluate(() => window.RolesCheck.skinIds()));
    const shots = {};
    for (const id of skinIds) {
      const info = await page.evaluate((sid) => window.RolesCheck.render(sid, null), id);
      assert.equal(info.ok, true, id + ' create 失败: ' + (info.reason || ''));
      if (id !== 'box') {
        assert.ok(info.skinnedMeshes >= 1, id + ' 应包含蒙皮网格');
      }
      assert.ok(info.hasWeapon && info.hasMarker, id + ' 缺 Weapon/TeamMarker');
      const file = path.join(outDir, id + '.png');
      await page.locator('#stage').screenshot({ path: file });
      shots[id] = fs.readFileSync(file);
      assert.ok(shots[id].length > 15000, id + ' 截图疑似空白画面');

      // 移动驱动：截图应与待机不同（动画在推进）
      await page.evaluate((sid) => window.RolesCheck.render(sid, { moving: true, speedRatio: 1, onGround: true }), id);
      const moveFile = path.join(outDir, id + '_run.png');
      await page.locator('#stage').screenshot({ path: moveFile });
      assert.ok(Buffer.compare(shots[id], fs.readFileSync(moveFile)) !== 0, id + ' 移动驱动无画面变化');
    }

    // 五张待机图两两不同
    for (let i = 0; i < skinIds.length; i++) {
      for (let j = i + 1; j < skinIds.length; j++) {
        assert.ok(
          Buffer.compare(shots[skinIds[i]], shots[skinIds[j]]) !== 0,
          skinIds[i] + ' 与 ' + skinIds[j] + ' 截图相同，模型没有切换'
        );
      }
    }
    assert.deepEqual(errors, [], '页面不应有 pageerror');
    console.log('check-roles OK：' + skinIds.length + ' 个角色截图已写入 tmp/roles-check/');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error('check-roles FAIL:', e.message);
  process.exit(1);
});
```

- [ ] **Step 4: 运行验证**

Run: `node scripts/check-roles.js`
Expected: 输出 `check-roles OK：5 个角色截图已写入 tmp/roles-check/`。

- [ ] **Step 5: 人工复核截图**

打开 `tmp/roles-check/` 的 10 张图，逐张确认：
1. 角色**面向镜头**（不是背对）——验证 `SoldierFacing` 的 π 翻转
2. 脚踩地面，不悬空不陷地
3. 站姿是手臂自然下垂（不是 A-pose 摊手）
4. 背上斜背着枪（枪管朝上），不穿模
5. 贴图无串色、无明显色块边界渗漏
6. `_run.png` 是迈步姿势

若背枪位置/角度不理想，只调 `js/soldier-voxel.js` `_mountBackWeapon` 里的 `Euler(Math.PI / 2, 0, 0)` 与偏移 `Vector3(0, 0.02, 0.14)` 两个常数，重跑 Step 4。

- [ ] **Step 6: Commit**

```bash
git add scripts/check-roles.html scripts/check-roles.js package.json
git commit -m "test(roles): 体素角色浏览器验证脚本"
```

---

### Task 8: 清理 Mixamo 试点残留

**Files:**
- Delete: `js/soldier-glb.js`（从未接入 index.html 的 Mixamo 试点，用户已批准删除）
- Delete: `assets/Soldier.glb`（试点模型，本地文件）
- Modify: `.gitignore`（删除 `assets/Soldier.glb` 一行）

注：`assets/Anims/` 的 Mixamo FBX 与 `.gitignore` 对应条目**保留不动**——删除它们不在用户批准范围内。

- [ ] **Step 1: 删除文件**

```bash
rm js/soldier-glb.js assets/Soldier.glb
```

`.gitignore` 中删除这一行：

```
assets/Soldier.glb
```

- [ ] **Step 2: 确认无残留引用**

Run: `grep -rn "soldier-glb\|SoldierGLB" --include=*.js --include=*.html js index.html scripts`
Expected: 无输出（除可能的注释历史外）。若 `diag-*.html` 里有引用无所谓——那是 .gitignore 的草稿区。

- [ ] **Step 3: 回归冒烟**

Run: 浏览器开首页 → 进部署页 → 选原型兵进一局单人 → 选体素兵再进一局。
Expected: 两局均正常；控制台无 `soldier-glb` 相关 404 或报错。

- [ ] **Step 4: Commit**

```bash
git add -A js/soldier-glb.js .gitignore
git commit -m "chore: 删除 Mixamo 试点 soldier-glb.js 与 Soldier.glb"
```

---

## 完成后的整体回归清单

- [ ] `node scripts/check-roles.js` 全绿
- [ ] 断网（或 DevTools 里把 `assets/characters/*.glb`  block 掉）→ 部署页正常打开显示盒子兵，控制台仅警告
- [ ] 单机一局：AI 与敌人全是盒子兵，战斗内无异常（本轮不改 AI/敌人）
- [ ] 两窗口联机：双方互见对方所选形象
- [ ] `git status` 干净；`git log --oneline` 8 个任务提交
