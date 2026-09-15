/**
 * weapon-models.js — 美术枪械 GLB（assets/weapons/*.glb）。
 *
 * 把三个消费点的程序化盒子枪换成美术资产：
 *   - js/weapon-viewmodels.js  buildGun(def)          第一人称手持
 *   - js/soldier.js            buildGunProp(style, z) 第三人称 / AI 手持
 *   - js/soldier-voxel.js      _mountBackWeapon()     背部挂枪
 *
 * 单独一个文件是刻意的，跟 vehicle-models.js 一个道理：soldier.js 会被
 * scripts/check-*.js 扔进 vm.runInNewContext 里跑（THREE 缺席），
 * 所以这些只能通过可选链的 VF.WeaponModels 查找进来，查找不到就回退程序化。
 *
 * 摆放约定（与项目一致）：
 *   - 游戏前方 = -Z；枪口在 -Z 远端，枪托在 +Z 近端
 *   - 枪口节点名 'Muzzle'，挂 MuzzleFlash（枪口火焰的 PointLight 父节点）
 *   - 原点：**各批资产不一样**，见下面 GLB_CONFIG 的说明
 *
 * 除了枪（batch 1/2）这里还登记了**投掷物**（batch 3，kind:'throwable'）。
 * 它们跟枪不是一类东西：长轴是 Y（竖着放，底面在 y≈0），没有枪口，
 * 所以走 center:'all' 把几何体三轴全归中（飞行时绕自己转才不会画圈），
 * 也不挂 Muzzle。消费点是 js/throwables.js 的 makeMesh（世界里的飞行/落地体）
 * 和 js/soldier.js createThrowableViewModel 的手持件，不是 buildGunProp。
 *
 * 烘焙：几何体一次性转成游戏坐标系并缩放（跟 vehicle-models.js 的 bakeGeometry
 * 同思路）。**不能**改 mesh/group 的 transform——player.js 和 soldier.js 每帧
 * 都会覆写 viewmodel 级别的 position/rotation/scale，放那儿会被冲掉。
 *
 * 原点**不做平移**，两道原因：
 *   1. 竖向不做 —— 模型本来就长在 y≥0，原点在枪底，回中会把纵向基准从
 *      枪底挪到枪身中部，第一人称摆位全得重调。
 *   2. 纵向不做 —— 各批资产原点位置本来就不同（第一批在握把、第二批在包围盒
 *      中心），而第一人称那套摆位用的是"原点距枪口多远"（muzzleDistance）来
 *      补偿，只要 muzzle 写对，原点在哪都能摆正。真遇到偏差再补平移不迟。
 */
(function (global) {
  'use strict';

  // 资产路径必须**相对站点根目录**，不能相对当前页面。
  // modes/small-battle/index.html 引的是 ../../js/*.js，脚本里的相对路径会解析到
  // /modes/small-battle/assets/... 而 404。从 document.currentScript 的 src 反推根：
  // 根 index.html 引的是 "js/xxx.js"，子目录引的是 "../../js/xxx.js"，
  // 两者 dirname 去掉 js/ 就是根。
  function assetRoot() {
    const S = document.currentScript;
    if (S && S.src) {
      let path = S.src.split('?')[0].split('#')[0];
      const jsIdx = path.lastIndexOf('/js/');
      if (jsIdx >= 0) return path.slice(0, jsIdx + 1);
    }
    return './';
  }
  const ROOT = assetRoot();

  const DIR = ROOT + 'assets/weapons/';
  const TOKEN = 'wpn3'; // 换资产时改这里，绕开浏览器缓存

  /**
   * 逐把配置。
   *
   * yawOffset —— 美术资产的枪口方向 → 游戏 -Z 所需绕 Y 轴的角度。
   *
   *   ⚠️ **两批资产的枪口方向是相反的**，别照抄：
   *     第一批 SM_*_001.glb（5 把）→ 枪口朝 **+Z** → yawOffset: Math.PI
   *     第二批 Mod_*.glb  （6 把）→ 枪口朝 **-Z** → yawOffset: 0
   *
   *   判断依据只能是**握把 / 扳机 / 弹匣 / 枪托的相对位置**，别用"哪一端细"：
   *     - 第一批的 M249 / MP5 / MP7 在枪管那端还有预留段 / 消焰器，截面反而
   *       更粗，按"细端=枪口"会判反；P90 / USP 的枪托又比握把粗，同样认错。
   *     - 第二批六把的 -Z 端特征都很明确：AK 的弹匣向前（朝 -Z）倾、
   *       M4 的 A 型前准星、SCAR 的大托板在 +Z 端、HK419 的 M-LOK 护木 + 消焰器。
   *
   *   上面这些话是 2026-09-15 用 scripts/check-weapons-side.js 的大图侧视
   *   （1400×520，两端分别标青/品红）逐把看出来的，不是猜的。再加新资产时
   *   照跑那个脚本，看图说话。
   *
   * muzzle: { x, z } —— 枪口在烘焙后坐标系里的位置（y 跟随枪管轴线，默认 0.04）。
   *   z 本可用包围盒最小值自动推，但枪管 -Z 端那截预留段会把枪口顶到枪身外
   *   两三厘米，枪口火焰会飘在前面。所以逐把写死。
   *
   * kind —— 'gun'（默认，长轴 Z、有枪口）/ 'throwable'（长轴 Y、无枪口、三轴归中）。
   *
   * center —— 'x'（默认，只把横向归中到轴线）/ 'all'（三轴全归中到几何中心）。
   *   投掷物用 'all'：飞行时 mesh 会随机转（js/throwables.js 的 _updateLive），
   *   如果原点在底面，转起来是绕着底边画圈而不是自转。
   *
   * scale —— 第三人称化身的视觉缩放。1 表示忠于真枪尺寸。
   *   盒子兵是按 2 米高的方块人 + 1.34 米夸张枪身搭的，真枪尺寸放上去会显小，
   *   所以逐把给了 >1 的系数把观感拉回原来的量级。
   *   pistol 尤其夸张——真手枪 0.21m 挂在方块人手上几乎看不见。
   *   第一人称**不吃这个系数**：枪在相机空间、参考系是准星，1 就正好，
   *   放大反而会糊住准星。分开是必须的，否则调第三人称会连累第一人称。
   */
  const GLB_CONFIG = {
    /* ===== 第一批：SM_*_001.glb，枪口朝 +Z，需转 π ===== */
    m249: {
      url: DIR + 'SM_M249_001.glb',
      yawOffset: Math.PI,
      muzzle: { x: 0, z: -0.54 },
      scale: 1.0,
    },
    mp5: {
      url: DIR + 'SM_MP5_001.glb',
      yawOffset: Math.PI,
      muzzle: { x: 0, z: -0.335 },
      scale: 1.4,
    },
    mp7: {
      url: DIR + 'SM_MP7_001.glb',
      yawOffset: Math.PI,
      muzzle: { x: 0, z: -0.315 },
      scale: 1.4,
    },
    p90: {
      url: DIR + 'SM_P90_001.glb',
      yawOffset: Math.PI,
      muzzle: { x: 0, z: -0.21 },
      scale: 1.6,
    },
    usp: {
      url: DIR + 'SM_USP_001.glb',
      yawOffset: Math.PI,
      muzzle: { x: 0, z: -0.135 },
      scale: 2.6,
    },

    /* ===== 第二批：Mod_*.glb，枪口朝 -Z，不用转 =====
     * 文件名是枪的型号而不是 weaponId，所以 url 必须一手一手对。
     * muzzle.z = 各自包围盒的 -Z 端（枪口就在那儿），逐把来自
     * scripts/check-weapons-side.js 的输出。
     * 这六把原点都在包围盒中心（不是握把），靠 muzzleDistance 补偿摆位，
     * 所以第三人称尺寸按 m249 的先例统一 1.0，跟第一批步枪保持一档。 */
    acr: {
      url: DIR + 'Mod_ACR.glb',
      yawOffset: 0,
      muzzle: { x: 0, z: -0.475 },
      scale: 1.0,
    },
    ak74: {
      url: DIR + 'Mod_AK_74.glb',
      yawOffset: 0,
      muzzle: { x: 0, z: -0.470 },
      scale: 1.0,
    },
    hk419: {
      url: DIR + 'Mod_HK419.glb',
      yawOffset: 0,
      muzzle: { x: 0, z: -0.468 },
      scale: 1.0,
    },
    m4a1: {
      url: DIR + 'Mod_M4A1.glb',
      yawOffset: 0,
      muzzle: { x: 0, z: -0.500 },
      scale: 1.0,
    },
    mk14ebr: {
      url: DIR + 'Mod_MK14EBR.glb',
      yawOffset: 0,
      muzzle: { x: 0, z: -0.476 },
      scale: 1.0,
    },
    scarh: {
      url: DIR + 'Mod_SCAR_H.glb',
      yawOffset: 0,
      muzzle: { x: 0, z: -0.592 },
      scale: 1.0,
    },

    /* ===== 第三批：投掷物，长轴 Y（竖着放），原点在底面中心 =====
     * 文件名同样是型号名不是 id：Mod_Grenade→frag、Mod_Flashbang→flash、
     * Mod_SmokeBomb→smoke。三个都是单 mesh 单材质内嵌 PNG、无骨骼无动画。
     * 尺寸（scripts/inspect-weapons.js 量出来的，真雷量级）：
     *   frag  0.079 × 0.103 × 0.073   （手雷最矮最胖）
     *   flash 0.062 × 0.162 × 0.063   （闪光弹最瘦长，真实比例也确实如此）
     *   smoke 0.061 × 0.140 × 0.063
     * 没有枪口，所以不写 muzzle 字段 —— attachMuzzle 会因此整段跳过。
     * 不用 yawOffset：竖着放本来就是对的姿态，转了反而躺倒。 */
    frag: {
      url: DIR + 'Mod_Grenade.glb',
      kind: 'throwable',
      center: 'all',
      yawOffset: 0,
      scale: 1.0,
    },
    flash: {
      url: DIR + 'Mod_Flashbang.glb',
      kind: 'throwable',
      center: 'all',
      yawOffset: 0,
      scale: 1.0,
    },
    smoke: {
      url: DIR + 'Mod_SmokeBomb.glb',
      kind: 'throwable',
      center: 'all',
      yawOffset: 0,
      scale: 1.0,
    },
  };

  const CACHE = {}; // weaponId -> { geometry, material, config }
  const FAILED = {}; // weaponId -> true（失败态也缓存，不反复重试）
  let loadPromise = null;

  function hasTHREE() {
    return !!(global.THREE && global.THREE.GLTFLoader);
  }

  /** 只打一次警告，避免每把枪都刷屏 */
  const warned = {};
  function warnOnce(key, message) {
    if (warned[key]) return;
    warned[key] = true;
    console.warn('[WeaponModels] ' + message + '；该枪回退程序化模型');
  }

  /**
   * 把朝向与缩放烘进几何体，并归拢成一个**居中于原点**的几何体。
   *
   * view：'fps' 忽略 GLB_CONFIG.scale（第一人称按真枪尺寸最好看）；
   *       'tps' / 'prop' 应用它（补方块人的观感）。
   * 两个视图各烘一份几何体并缓存——几何体很便宜（1~2k 面），
   * 复制一份远比每帧算缩放划算，而且避开 transform 被覆写的问题。
   */
  function bakeGeometry(THREE, geometry, config, view) {
    const geo = geometry.clone();
    if (config.yawOffset) geo.rotateY(config.yawOffset);

    // 横向归中到轴线。高度不回中——握把在 y=0 附近，模型本来就在 y 正方向
    // 生长，回中会把纵向基准从握把挪到枪身中部，第一人称摆位全得重调。
    geo.computeBoundingBox();
    const box = geo.boundingBox;
    if (config.center === 'all') {
      // 投掷物：三轴全归中到几何中心。飞行时会随机转，原点必须在质心上
      // 才是自转，否则是绕底边画圈。
      geo.translate(
        -(box.min.x + box.max.x) / 2,
        -(box.min.y + box.max.y) / 2,
        -(box.min.z + box.max.z) / 2
      );
    } else {
      geo.translate(-(box.min.x + box.max.x) / 2, 0, 0);
    }

    const scale = view === 'fps' ? 1 : config.scale || 1;
    if (scale !== 1) geo.scale(scale, scale, scale);

    // 标记成共享资源：几何体/材质是在 CACHE 里复用的一份，
    // 调用方（js/arsenal.js 的展示面板刷新时会 dispose 旧枪）不能把它析构掉，
    // 否则同一把枪还在第一人称 / 背枪上用着，GPU 缓冲会被白扔一次。
    geo.userData.shared = true;

    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  /** 取第一个 mesh 的材质，并对第一人称做适配（关雾、不剔面） */
  function cloneMaterial(THREE, source) {
    const mat = source ? source.clone() : new THREE.MeshLambertMaterial({ color: 0x2e343c });
    mat.fog = false; // 第一人称 viewmodel 不参与场景雾
    if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace || mat.map.colorSpace;
    // 美术资产是 PBR；场景光照是按 Lambert 调的（soldier.js 的注释也这么说），
    // 纯金属度会发黑，压一压让它在现有光照下还能看清。
    if (mat.metalness != null && mat.metalness > 0.35) mat.metalness = 0.35;
    if (mat.roughness != null && mat.roughness < 0.45) mat.roughness = 0.45;
    // 同上：这份材质也缓存在 CACHE 里共享，别被调用方 dispose
    mat.userData = mat.userData || {};
    mat.userData.shared = true;
    mat.needsUpdate = true;
    return mat;
  }

  function loadOne(THREE, id) {
    const config = GLB_CONFIG[id];
    return new Promise(function (resolve) {
      new THREE.GLTFLoader().load(
        config.url + '?v=' + TOKEN,
        function (gltf) {
          try {
            let source = null;
            gltf.scene.traverse(function (child) {
              if (!source && child.isMesh && child.geometry) source = child;
            });
            if (!source) {
              warnOnce(id + ':noMesh', id + ' 资产里没有可用的 mesh');
              FAILED[id] = true;
              resolve(null);
              return;
            }
            const fpsGeo = bakeGeometry(THREE, source.geometry, config, 'fps');
            const tpsGeo = config.scale && config.scale !== 1
              ? bakeGeometry(THREE, source.geometry, config, 'tps')
              : fpsGeo;
            CACHE[id] = {
              id: id,
              geometry: fpsGeo, // 第一人称
              propGeometry: tpsGeo, // 第三人称 / 背枪
              material: cloneMaterial(THREE, source.material),
              config: config,
            };
            resolve(CACHE[id]);
          } catch (error) {
            warnOnce(id + ':bake', id + ' 资产处理失败: ' + (error && error.message));
            FAILED[id] = true;
            resolve(null);
          }
        },
        undefined,
        function (error) {
          warnOnce(id + ':load', id + ' 资产加载失败: ' + ((error && error.message) || error));
          FAILED[id] = true;
          resolve(null);
        }
      );
    });
  }

  /* ---------- 枪口 ---------- */

  const MUZZLE_Y = 0.04; // 与程序化枪的枪口高度一致，火焰看着才在同一水平

  function attachMuzzle(THREE, gun, id, view) {
    const muzzle = new THREE.Object3D();
    muzzle.name = 'Muzzle';

    // 枪口偏移是**真枪尺寸**下量的，第三人称几何体被放大过，偏移要同倍缩放，
    // 否则枪口火焰会落在枪管里（第三人称本来不放火焰，但保持一致更省心）。
    const k = view === 'fps' ? 1 : ((GLB_CONFIG[id] || {}).scale || 1);

    // 优先用资产自带的 Muzzle 节点（若美术后来补了）
    let source = null;
    const entry = CACHE[id];
    if (entry && entry.sourceMuzzle) source = entry.sourceMuzzle;
    if (source) {
      muzzle.position.copy(source).multiplyScalar(k);
    } else {
      const entryConfig = (GLB_CONFIG[id] || {}).muzzle || {};
      muzzle.position.set((entryConfig.x || 0) * k, MUZZLE_Y * k, (entryConfig.z || -0.4) * k);
    }

    const flash = new THREE.Object3D();
    flash.name = 'MuzzleFlash';
    muzzle.add(flash);
    gun.add(muzzle);
    return { muzzle: muzzle, flash: flash };
  }

  /* ---------- 对外 ---------- */

  /**
   * 造枪体。view: 'fps'（第一人称，真枪尺寸）| 'tps'（第三人称/背枪，吃缩放）。
   */
  function buildWith(id, view) {
    const THREE = global.THREE;
    const entry = CACHE[id];
    if (!THREE || !entry) return null;

    const config = GLB_CONFIG[id] || {};
    const throwable = config.kind === 'throwable';

    const gun = new THREE.Group();
    gun.name = throwable ? 'ViewThrowable' : 'ViewGun';
    gun.frustumCulled = false;
    // 给调用方一个明确的标记：这棵树用的是共享几何体/材质，不能 dispose。
    // 现在有两处会 dispose（js/arsenal.js 的展示面板），靠这个标记兜底。
    gun.userData.artAssets = true;

    const geo = view === 'fps' ? entry.geometry : entry.propGeometry;
    const mesh = new THREE.Mesh(geo, entry.material);
    mesh.name = 'WeaponMesh';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    gun.add(mesh);

    // 投掷物没有枪口（GLB_CONFIG 里不写 muzzle 字段），整段跳过 ——
    // 否则会在手雷旁边凭空挂一个 y=0.04 / z=-0.4 的 MuzzleFlash。
    const parts = config.muzzle ? attachMuzzle(THREE, gun, id, view) : { muzzle: null, flash: null };
    return { gun: gun, muzzle: parts.muzzle, flash: parts.flash, glb: true };
  }

  const WeaponModels = {
    /** 该武器有没有可用的美术资产 */
    has: function (id) {
      return !!(id && CACHE[id]);
    },

    /**
     * 资产类型：'gun'（默认）/ 'throwable'。没登记的 id 也返回 'gun'。
     */
    kind: function (id) {
      return (GLB_CONFIG[id] || {}).kind || 'gun';
    },

    /**
     * 已登记的 id 列表。**注意现在混了枪和投掷物**，只想要枪就传 'gun'。
     * 传 kind 参数过滤；不传返回全部（含投掷物）。
     */
    ids: function (kind) {
      const all = Object.keys(GLB_CONFIG);
      if (!kind) return all;
      return all.filter(function (id) {
        return ((GLB_CONFIG[id] || {}).kind || 'gun') === kind;
      });
    },

    /**
     * 枪口在握把前方的距离（米，正数）。第一人称摆位要按枪长往后撤，
     * 短枪（USP 0.135）和长枪（M249 0.54）差 4 倍，不能用一个常数。
     * 没资产时返回 null，调用方回退到程序化枪的 1.05。
     */
    muzzleDistance: function (id) {
      const entry = CACHE[id];
      if (!entry) return null;
      if ((GLB_CONFIG[id] || {}).kind === 'throwable') return null; // 投掷物没有枪口
      const cfg = (GLB_CONFIG[id] || {}).muzzle;
      if (cfg && cfg.z != null) return Math.abs(cfg.z);
      return Math.abs(entry.geometry.boundingBox.min.z);
    },

    /** 把程序化枪体换成 GLB（第一人称）。返回 { gun, muzzle, flash } 或 null */
    build: function (id) {
      return buildWith(id, 'fps');
    },

    /** 只要枪体，第三人称尺寸、不含枪口子节点——背枪用（背枪不需要开火） */
    buildProp: function (id) {
      const built = buildWith(id, 'tps');
      return built ? built.gun : null;
    },

    /**
     * 预载。单飞 + 容错：某把失败就保持 FAILED，不影响其它枪，也不阻塞启动。
     * 不传 ids 就预载全部；传了只预载指定几把。
     */
    preload: function (ids) {
      const THREE = global.THREE;
      if (!THREE || !THREE.GLTFLoader) {
        warnOnce('noLoader', 'GLTFLoader 不可用（需要重新构建 three bundle）');
        return Promise.resolve(0);
      }
      const list = (ids && ids.length ? ids : Object.keys(GLB_CONFIG)).filter(function (id) {
        return GLB_CONFIG[id] && !CACHE[id] && !FAILED[id];
      });
      if (!list.length) return Promise.resolve(0);
      return Promise.all(
        list.map(function (id) {
          return loadOne(THREE, id).catch(function () {
            return null;
          });
        })
      ).then(function (results) {
        const ok = results.filter(Boolean).length;
        if (ok) console.log('[WeaponModels] 美术枪械就绪: ' + results.filter(Boolean).map(function (e) { return e.id; }).join(', '));
        return ok;
      });
    },

    /** 预载全部（幂等，单飞） */
    preloadAll: function () {
      if (!loadPromise) loadPromise = this.preload(null);
      return loadPromise;
    },
  };

  global.VF = global.VF || {};
  global.VF.WeaponModels = WeaponModels;
})(typeof window !== 'undefined' ? window : globalThis);
