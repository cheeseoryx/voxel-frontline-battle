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
    // 防御「只创建不驱动」的消费者（PvP 远端化身曾因此渲染成 A-pose）
    mixer.update(0);

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

  // 动作库约 217KB，启动即预载；皮肤按需（部署页打开时 preloadAll）
  preloadAnims();
})(window);
