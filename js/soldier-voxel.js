/**
 * soldier-voxel.js — 兵种角色模型（Soldier01–04，UE5 导出的 Bip001 骨架 GLB）
 *
 * 兵种与美术 GLB 一一对应，**不是皮肤**：选定兵种即选定模型，玩家没有
 * 第二个形象维度。兵种→文件映射见下方 CLASS_MODELS。
 *
 * - VF.SoldierVoxel.CLASS_MODELS           兵种 → 模型元数据
 * - VF.SoldierVoxel.preload(classId)       懒加载单个兵种模型（含动作库）
 * - VF.SoldierVoxel.preloadAll()           加载全部兵种模型
 * - VF.SoldierVoxel.isReady(classId)
 * - VF.SoldierVoxel.create(classId, {team, weaponId, armed})  克隆出一个骨骼角色
 *     armed:true → 端着枪（枪挂右手骨骼 Dummy001_R-Hand，枪管轴线按"右手→左手"
 *     两个挂点每帧解算，移动播 RifleRun）；默认 false → 只把枪背在身后（Dummy001）。
 *     场上 AI 走 armed，见 js/ai.js。
 * - VF.SoldierVoxel.drive(root, dt, state)    每帧 locomotion（由 Soldier.updateLocomotion 委托）
 * - VF.SoldierVoxel.driveArmed(root, dt, state)  第三人称端枪角色的 locomotion（AI 小队）
 * - VF.SoldierVoxel.driveRifle(root, dt, state)  第一人称化身的持枪版 locomotion
 *     （见 js/soldier.js 的 createArtViewModel）——与 driveArmed 同一份实现
 * - VF.SoldierVoxel.setFiring(root, on)       开火状态开关（循环 ShootAuto，不 reset）
 * - VF.SoldierVoxel.fire(root) / hit(root) / die(root) / jump(root, phase)
 *     一次性动作。播完自动回落到 locomotion；die 是终态，停在最后一帧。
 *
 * 由 VF.Soldier.createClassSoldier 在模型就绪时自动取用；未就绪时静默
 * 回退程序化盒子兵，加载完成后 next 帧重建即可换上。
 *
 * 资产约定（烘焙产物，见 scripts/bake-roles.js）：
 * - assets/characters/soldier01..04.glb   蒙皮网格，共用同一副 Bip001 骨架
 * - assets/characters/soldier_anims.glb   仅骨架 + 18 个 clip（见 CLIP）
 *   四个角色骨架同名同构，动作 track 按节点名寻址，直接套用，无 retarget。
 * - 模型原生面朝 +Z（脚趾相对脚踝在 +Z 侧），与盒子兵一致 → SoldierFacing
 *   沿用 rotation.y = π。
 * - 全部 clip 已由烘焙压成原地动画（Death / HitLarge 原本带约 1m 根位移）。
 *
 * 状态优先级：dead > 一次性动作 > 跳跃 > 蹲伏 > 站立移动。
 * 蹲伏状态读 root.userData.crouchPose（Soldier.setCrouchPose 写的 target），
 * 因为 Soldier.updateCrouchPose 对骨骼角色是跳过的——它会缩放 Y 压扁骨架、
 * 并改背挂枪的 rotation.x，把推导出的四元数毁掉。
 */
(function (global) {
  'use strict';

  // 资产路径必须**相对站点根目录**，不能相对当前页面。
  // modes/small-battle/index.html 引的是 ../../js/*.js，脚本里的相对路径会解析到
  // /modes/small-battle/assets/... 而 404 —— 兵种模型一直加载不上就是这么来的。
  // 从 document.currentScript 的 src 反推仓库根：根 index.html 引的是 "js/xxx.js"，
  // 子目录引的是 "../../js/xxx.js"，两者 dirname 去掉 js/ 就是根。
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

  const CHAR_DIR = ROOT + 'assets/characters/';
  const ANIMS_URL = CHAR_DIR + 'soldier_anims.glb';

  // 兵种 → 美术 GLB（美术命名顺序：01 突击 / 02 机枪兵 / 03 侦察兵 / 04 支援兵）
  const CLASS_MODELS = {
    assault: { file: 'soldier01.glb', nameZh: '突击' },
    engineer: { file: 'soldier02.glb', nameZh: '机枪兵' },
    recon: { file: 'soldier03.glb', nameZh: '侦察兵' },
    support: { file: 'soldier04.glb', nameZh: '支援兵' },
  };
  const CLASS_IDS = Object.keys(CLASS_MODELS);

  // 必须与 scripts/bake-roles.js 里 ANIMS[].name 完全一致，改那边也要改这边
  const CLIP = {
    idle: 'Idle',
    walk: 'Walk',
    run: 'Run',
    sprint: 'Sprint',
    crouchIdle: 'CrouchIdle',
    crouchWalk: 'CrouchWalk',
    jumpStart: 'JumpStart',
    jumpLoop: 'JumpLoop',
    jumpEnd: 'JumpEnd',
    shoot: 'Shoot',
    reload: 'Reload',
    aimIdle: 'AimIdle',
    hit: 'Hit',
    hitLarge: 'HitLarge',
    death: 'Death',
    // 持枪动作组：角色端着枪时的移动/射击。第一人称化身用这一组，
    // 与「持枪警戒待机」保持一致（Idle 本身就是 Common_Fight_Idle）。
    rifleRun: 'RifleRun',
    rifleCrouchAim: 'RifleCrouchAim',
    shootAuto: 'ShootAuto',
  };
  // 缺这几个就不算就绪（站立与移动是硬需求）
  const REQUIRED_CLIPS = [CLIP.idle, CLIP.walk, CLIP.run];

  /* 手持枪挂点与摆位（armed 角色用，见 _mountHandWeapon / _alignHandGun） */
  // 右手 = 握把手（枪从这里长出去），左手 = 支撑手（护木）。
  // 两个挂点的连线就是枪管轴线 —— 美术那套持枪 clip 两只手是握着同一把枪的
  // （AimIdle / ShootAuto / RifleRun / RifleCrouchAim 里两手间距恒为 0.55/0.42m）。
  const HAND_SOCKET = 'Dummy001_R-Hand';
  const HAND_SOCKET_L = 'Dummy002_L-Hand';
  // 握把在枪身长度上距枪托（+Z 端）的比例。不按原点算：两批美术枪一批原点在
  // 包围盒中心、一批贴着握把，只有按包围盒量才统一。
  const GRIP_BACK = 0.25;
  // 握把点相对枪身原点的手心微调，**枪的本地空间**（+X 右 / +Y 上 / -Z 枪口）。
  // y 取负 = 握把在枪膛轴线下方，手心托住握把而不是托住枪管。
  const HAND_GRIP = { x: 0, y: -0.035, z: 0 };
  // 在两手轴线基础上再叠的微调（一般留 0，肉眼调参用）
  const HAND_PITCH = 0; // 俯仰（正 = 枪口朝下）
  const HAND_YAW = 0; // 左右偏（正 = 朝左）
  const HAND_ROLL = 0; // 绕枪管滚转
  // 两手太近 → 这一帧没有"双手持枪"信息，退回锁角色正前方
  const HAND_AXIS_MIN = 0.18;

  const RUN_THRESHOLD = 0.85; // speedRatio 达到此值播 Run，否则 Walk
  const SPRINT_THRESHOLD = 1.05; // 再往上播 Sprint（pvp 里 speed/6 封顶 1.2）
  const HYSTERESIS = 0.12; // 走/停 120ms 滞回，防止边界每帧互切
  const CROUCH_ON = 0.5; // 蹲下插值过半才算蹲，避免在阈值上反复横跳
  const LOOP_FADE = 0.18;
  const ONCE_FADE = 0.08;
  const POSE_LERP = 12; // 蹲伏插值速度，与 Soldier.updateCrouchPose 一致

  let _anims = null; // { clips: {Idle, Walk, ...} }
  let _animsPromise = null;
  const _models = {}; // classId -> { gltf }
  const _modelPromises = {}; // classId -> Promise<bool>（失败态同样缓存）

  function isValidClass(id) {
    return Object.prototype.hasOwnProperty.call(CLASS_MODELS, id);
  }

  function isReady(classId) {
    return !!_anims && !!(_models[classId] && _models[classId].gltf);
  }

  function isAnyReady() {
    return CLASS_IDS.some(isReady);
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
      const missing = REQUIRED_CLIPS.filter(function (n) {
        return !clips[n];
      });
      if (missing.length) {
        console.warn(
          '[SoldierVoxel] 动作库缺 clip:', missing.join(','),
          '（现有:', Object.keys(clips).join(',') + '）'
        );
        return false;
      }
      _anims = { clips: clips };
      console.log('[SoldierVoxel] 动作库就绪:', Object.keys(clips).join(', '));
      return true;
    });
    return _animsPromise;
  }

  function preload(classId) {
    if (!isValidClass(classId)) return Promise.resolve(false);
    if (_modelPromises[classId]) return _modelPromises[classId];
    const meta = CLASS_MODELS[classId];
    _modelPromises[classId] = Promise.all([
      preloadAnims(),
      _loadGltf(CHAR_DIR + meta.file),
    ]).then((results) => {
      const ok = !!(results[0] && results[1]);
      if (ok) {
        _models[classId] = { gltf: results[1] };
        console.log('[SoldierVoxel] 兵种模型就绪:', classId);
      }
      return ok;
    });
    return _modelPromises[classId];
  }

  function preloadAll() {
    return Promise.all(CLASS_IDS.map(preload));
  }

  /* ---------- 背部挂枪 ---------- */

  // 挂在脊椎后方的 Dummy001 挂点（模型网格不含武器）。
  // 朝向推导：wrap(rotation.y=π) 之后模型的"背后"是世界 +Z；
  // 让枪背(+Y)朝世界 +Z、枪管(-Z)朝世界 +Y——即枪管朝上斜背在身后。
  //
  // weaponId 有美术 GLB 时用它（js/weapon-models.js），否则回退程序化步枪。
  function _mountBackWeapon(model, wrap, weaponId) {
    let art = null;
    const M = global.VF.WeaponModels;
    if (weaponId && M && M.buildProp) art = M.buildProp(weaponId);
    if (!art && !(global.VF.Soldier && global.VF.Soldier.buildGunProp)) return null;
    const socket = model.getObjectByName('Dummy001');
    if (!socket) return null;
    wrap.updateMatrixWorld(true);
    let built;
    if (art) {
      built = { gun: art, muzzle: art.getObjectByName('Muzzle'), flash: null };
    } else {
      built = global.VF.Soldier.buildGunProp('rifle', -0.85);
    }
    const gun = built.gun;
    const desired = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.PI / 2, 0, 0)
    );
    const socketQ = new THREE.Quaternion();
    socket.getWorldQuaternion(socketQ);
    const inv = socketQ.clone().invert();
    // gun.quaternion 满足 socketQ * gun.quaternion = desired
    gun.quaternion.copy(inv.clone().multiply(desired));
    // 往背外挪一点避免穿模（世界方向 → socket 局部）。
    // 美术枪原点在握把、整体比程序化枪短，背上去要更贴背一点。
    const out = art
      ? new THREE.Vector3(0, 0.02, 0.1)
      : new THREE.Vector3(0, 0.02, 0.14);
    const local = out.applyQuaternion(inv);
    gun.position.copy(local);
    socket.add(gun);
    return built;
  }

  /**
   * 量出枪自身在**本地空间**的包围盒（枪口在 -Z 端）。
   * 用来定位握把：两批美术枪一批原点在包围盒中心、一批贴着握把，
   * 只有按包围盒算"后 25%"才能让手心正好落在握把上。
   */
  function _localBBox(gun) {
    gun.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(gun.matrixWorld).invert();
    const box = new THREE.Box3();
    let any = false;
    gun.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      // 枪口火焰是空节点的占位图元，别算进枪身长度
      if (/^(Muzzle|Flash)/.test(o.name)) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone();
      b.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      box.union(b);
      any = true;
    });
    return any ? box : null;
  }

  /**
   * 手持枪：挂在右手骨骼下（Dummy001_R-Hand），位置与朝向每帧由 _alignHandGun 定。
   *
   * 为什么挂骨骼而不是 root：持枪动作（AimIdle / RifleRun / ShootAuto）的手臂
   * 是动起来的，枪挂在根节点上就成了"人跑枪不抬手、人站枪不动"。
   *
   * @param {THREE.Object3D} model 骨骼角色（create 里 clone 出来的 scene）
   * @param {string|null} weaponId 有美术 GLB 时用 GLB，否则程序化步枪
   */
  function _mountHandWeapon(model, weaponId) {
    const socket = model.getObjectByName(HAND_SOCKET);
    if (!socket) return null;
    let built;
    const M = global.VF.WeaponModels;
    if (weaponId && M && M.buildProp) {
      const art = M.buildProp(weaponId);
      if (art) built = { gun: art, muzzle: art.getObjectByName('Muzzle'), flash: null };
    }
    if (!built) {
      if (!(global.VF.Soldier && global.VF.Soldier.buildGunProp)) return null;
      built = global.VF.Soldier.buildGunProp('rifle', -0.85);
    }
    const gun = built.gun;
    const box = _localBBox(gun);
    // 握把在枪身长度上距枪托的位置（枪口在 -Z，所以"后方"是 +Z）
    built.gripZ = box ? box.max.z - (box.max.z - box.min.z) * GRIP_BACK : 0;
    socket.add(gun); // 位置/朝向交给 _alignHandGun
    return built;
  }

  // 在两手轴线基础上再叠的微调旋转（HAND_* 全 0 时不用算）
  const _handDirQuat = new THREE.Quaternion();
  let _handDirReady = false;
  function _handDesired() {
    if (!_handDirReady) {
      _handDirQuat.setFromEuler(new THREE.Euler(HAND_PITCH, HAND_YAW, HAND_ROLL, 'YXZ'));
      _handDirReady = true;
    }
    return _handDirQuat;
  }

  const _q1 = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _q3 = new THREE.Quaternion();
  const _m1 = new THREE.Matrix4();
  const _m2 = new THREE.Matrix4();
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _v4 = new THREE.Vector3();
  const _v5 = new THREE.Vector3();
  const _vf = new THREE.Vector3(); // 枪口方向（fwd），单独一个：绝不能和 up 共用，否则
                                   // _v2.set(0,1,0) 会把 fwd 一起覆盖掉，正交基直接算废

  /**
   * 把右手上的枪摆正：**枪管轴线 = 右手挂点 → 左手挂点**，握把落在右手上。
   *
   * 为什么不跟手腕骨骼朝向、也不锁角色正前方（两者都试过，都不对）：
   *  - 跟手腕：美术那组持枪 clip 之间**手腕自身的朝向**差得很多，
   *    按 AimIdle 的手腕标定后，RifleRun 里枪口会歪出去 30~40°。
   *  - 锁角色正前方：AimIdle 看着还行，但 RifleRun 美术把枪抱在胸侧横向朝前，
   *    于是左手（支撑手）永远落在枪外 0.5m —— 就是"没握住"的观感。
   *  - 按两手连线：两只手是握着**同一把枪**的（实测 AimIdle / ShootAuto /
   *    RifleCrouchAim / RifleRun 两手间距恒定 0.42~0.58m，且左手始终落在
   *    右手本地 +Y 方向 ~0.55m），所以连线就是枪管轴线，这么摆两只手必然都在枪上。
   *
   * 必须在 mixer.update() **之后**调用（FPS 那边 alignGun 同理）——提前算拿到的是
   * 上一帧的骨骼矩阵，枪会比手慢一帧、快速转身时看着在手上打滑。
   *
   * 滚转需要一个"上"参照：用**角色自身的上方向**（不是世界 +Y），这样人一转向/侧倾
   * 枪跟着走，不会横过来。
   */
  function _alignHandGun(root, a) {
    const gun = a && a.heldGun;
    if (!gun || !gun.parent) return;
    const socket = gun.parent;

    // 只更新到两手的祖先链，不整棵树重算（每帧每个 AI 都要跑）
    socket.updateWorldMatrix(true, false);
    root.updateWorldMatrix(true, false);

    _v1.setFromMatrixPosition(socket.matrixWorld); // 右手世界坐标 = 握把锚点

    // 枪口方向 = 右手 → 左手
    let hasFwd = false;
    const lsock = a.heldGunL;
    if (lsock) {
      lsock.updateWorldMatrix(true, false);
      _vf.setFromMatrixPosition(lsock.matrixWorld).sub(_v1);
      hasFwd = _vf.lengthSq() > HAND_AXIS_MIN * HAND_AXIS_MIN;
      if (hasFwd) _vf.normalize();
    }
    root.getWorldQuaternion(_q2);
    if (!hasFwd) {
      // 兜底（缺左手挂点 / 两手重合）：锁角色正前方
      _vf.set(0, 0, -1).applyQuaternion(_q2).normalize();
    }

    // 正交基：枪的局部 -Z → fwd，局部 +Y → 角色上方向（消掉滚转歧义）
    _v2.set(0, 1, 0).applyQuaternion(_q2); // up 基准
    _v2.addScaledVector(_vf, -_v2.dot(_vf));
    if (_v2.lengthSq() < 1e-8) _v2.set(0, 1, 0).addScaledVector(_vf, -_vf.y);
    _v2.normalize(); // up
    _v3.copy(_vf).negate(); // 局部 +Z 的世界方向
    _v4.crossVectors(_v2, _v3); // 局部 +X = Y × Z
    _m1.makeBasis(_v4, _v2, _v3);
    _q1.setFromRotationMatrix(_m1); // 枪的目标世界四元数
    if (HAND_PITCH || HAND_YAW || HAND_ROLL) _q1.multiply(_handDesired());

    // 位置：把枪上的"握把点"摆到右手上
    _v5.set(HAND_GRIP.x, HAND_GRIP.y, a.gripZ || 0).applyQuaternion(_q1);
    _v4.copy(_v1).sub(_v5); // 枪原点的世界坐标

    // 世界 → 骨骼局部
    socket.getWorldQuaternion(_q3).invert();
    gun.quaternion.copy(_q3.multiply(_q1));
    _m2.copy(socket.matrixWorld).invert();
    gun.position.copy(_v4.applyMatrix4(_m2));
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
    opts = opts || {};
    // 入参即兵种；兼容旧调用 create(skinId, { classId }) —— 非兵种 id 时回落到 opts.classId
    let classId = isValidClass(id) ? id : opts.classId;
    if (!isValidClass(classId)) classId = 'assault';
    if (!isReady(classId)) return null;
    const team = opts.team === 'enemy' ? 'enemy' : 'ally';

    const src = _models[classId].gltf;
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

    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    Object.keys(_anims.clips).forEach((name) => {
      actions[name] = mixer.clipAction(_anims.clips[name]);
    });

    root.userData.glbAnim = {
      mixer: mixer,
      actions: actions,
      current: null,
      time: 0,
      motionState: 'idle',
      motionCandidate: null,
      motionCandidateTime: 0,
      crouching: false,
      once: null, // { action, time, duration, hold }
      jumpPhase: null, // 'start' | 'loop' | 'end'
      dead: false,
    };

    // armed：端着枪的角色（AI 小队默认就是这种）。枪挂右手骨骼，位置/朝向每帧由
    // _alignHandGun 按"右手 → 左手"的枪管轴线重算，所以这里挂完先摆一次位，
    // 免得第一帧出现在原点。
    const armed = !!opts.armed;
    let muzzle = null;
    if (armed) {
      switchTo(root.userData.glbAnim, CLIP.aimIdle, { loop: true, fade: 0 });
      mixer.update(0);
      const held = _mountHandWeapon(model, opts.weaponId);
      if (held) {
        muzzle = held.muzzle;
        root.userData.glbAnim.armed = true;
        root.userData.glbAnim.heldGun = held.gun;
        root.userData.glbAnim.heldGunL = model.getObjectByName(HAND_SOCKET_L);
        root.userData.glbAnim.gripZ = held.gripZ;
        root.updateMatrixWorld(true);
        _alignHandGun(root, root.userData.glbAnim);
      }
    } else {
      const gunBits = _mountBackWeapon(model, wrap, opts.weaponId);
      if (gunBits) muzzle = gunBits.muzzle;
    }
    root.userData.armed = armed;

    _addTeamMarker(root, team);

    // 防御「只创建不驱动」的消费者（PvP 远端化身曾因此渲染成 A-pose）
    if (!armed) switchTo(root.userData.glbAnim, CLIP.idle, { loop: true, fade: 0 });
    mixer.update(0);

    root.userData.muzzle = muzzle;
    root.userData.variant = classId;
    root.userData.classId = classId;
    root.userData.team = team;
    root.frustumCulled = false;
    return root;
  }

  /* ---------- 动作切换 ---------- */

  function switchTo(a, name, opts) {
    const target = a.actions[name];
    if (!target) return null;
    opts = opts || {};
    if (a.current === target && !opts.force) return target;
    const prev = a.current;
    const fade = opts.fade != null ? opts.fade : LOOP_FADE;
    target.reset();
    if (opts.loop === false) {
      target.setLoop(THREE.LoopOnce, 1);
      target.clampWhenFinished = true;
    } else {
      target.setLoop(THREE.LoopRepeat, Infinity);
      target.clampWhenFinished = false;
    }
    target.timeScale = opts.timeScale || 1;
    if (fade > 0) target.fadeIn(fade);
    target.play();
    if (prev && prev !== target) {
      if (fade > 0) prev.fadeOut(fade);
      else prev.stop();
    }
    a.current = target;
    return target;
  }

  // 一次性动作：播完自动回落到 locomotion。hold=true 则停在最后一帧（死亡）。
  function playOnce(root, clipName, opts) {
    const a = root && root.userData && root.userData.glbAnim;
    if (!a) return;
    opts = opts || {};
    if (a.dead && !opts.force) return; // 死了就不再响应别的一次性动作
    const action = a.actions[clipName];
    if (!action) return;
    const ts = opts.timeScale || 1;
    switchTo(a, clipName, { loop: false, fade: ONCE_FADE, timeScale: ts, force: true });
    a.once = {
      action: action,
      time: 0,
      duration: action.getClip().duration / ts,
      hold: !!opts.hold,
    };
  }

  /* ---------- 对外的一次性动作 ---------- */

  function fire(root) {
    playOnce(root, CLIP.shoot, { timeScale: 1.6 }); // 0.8s -> 0.5s，跟射速对得上
  }

  function reload(root) {
    playOnce(root, CLIP.reload);
  }

  function hit(root, big) {
    playOnce(root, big ? CLIP.hitLarge : CLIP.hit);
  }

  function die(root) {
    const a = root && root.userData && root.userData.glbAnim;
    if (!a || a.dead) return;
    a.dead = true;
    a.once = null;
    playOnce(root, CLIP.death, { force: true, hold: true });
  }

  // 复活：清掉死亡终态，下一帧 drive 自然切回 locomotion
  function revive(root) {
    const a = root && root.userData && root.userData.glbAnim;
    if (!a) return;
    a.dead = false;
    a.once = null;
    a.jumpPhase = null;
    a.needResume = true;
    a.motionState = 'idle';
    a.motionCandidate = null;
    a.motionCandidateTime = 0;
    a.time = 0;
  }

  // phase: 'start' 起跳 / 'loop' 滞空 / 'end' 落地（end 播完自动回落）
  function jump(root, phase) {
    const a = root && root.userData && root.userData.glbAnim;
    if (!a || a.dead) return;
    if (phase === 'start') {
      a.jumpPhase = 'start';
      playOnce(root, CLIP.jumpStart);
    } else if (phase === 'loop') {
      a.jumpPhase = 'loop';
      a.once = null;
      switchTo(a, CLIP.jumpLoop, { loop: true, force: true });
    } else {
      a.jumpPhase = 'end';
      playOnce(root, CLIP.jumpEnd);
    }
  }

  /* ---------- 每帧驱动 ---------- */

  // 蹲伏插值：Soldier.updateCrouchPose 对骨骼角色直接 return，所以这里自己推进
  function _crouchT(root, dt) {
    const cp = root.userData.crouchPose;
    if (!cp) return 0;
    cp.current += (cp.target - cp.current) * Math.min(1, dt * POSE_LERP);
    return cp.current;
  }

  /**
   * 一次性动作计时（必须在 mixer.update 之前判断，这样结束帧立刻回落）。
   * drive / driveRifle 共用。
   */
  function _advanceOnce(a, dt) {
    if (!a.once) return;
    a.once.time += dt;
    if (a.once.time < a.once.duration) return;
    const hold = a.once.hold;
    a.once = null;
    if (hold) return;
    if (a.jumpPhase === 'start') {
      // 起跳完自动接滞空
      a.jumpPhase = 'loop';
      switchTo(a, CLIP.jumpLoop, { loop: true, fade: ONCE_FADE });
    } else {
      a.jumpPhase = null;
      // 记一个标记，让下面的 locomotion 分支 force 切一次——
      // 不 force 的话 switchTo 会因为 target===current 直接早退，
      // 一次性动作就永远停在最后一帧上。
      a.needResume = true;
    }
  }

  function drive(root, dt, state) {
    const a = root.userData.glbAnim;
    if (!a) return;
    state = state || {};
    dt = dt || 0.016;

    _advanceOnce(a, dt);

    if (!a.once && !a.dead) {
      const onGround = state.onGround !== false;
      const sr =
        state.speedRatio != null ? state.speedRatio : state.moving ? 1 : 0;
      const moving = !!state.moving && sr > 0.08 && onGround && !a.jumpPhase;

      // 空中：不切 locomotion，保持 JumpStart/JumpLoop 播完
      if (a.jumpPhase) {
        // jumpPhase 由 jump() 驱动，这里不动
      } else {
        const crouchT = _crouchT(root, dt);
        // 过半才算蹲 / 低于 0.35 才算站，中间是滞回区，避免阈值抖动
        if (!a.crouching && crouchT > CROUCH_ON) a.crouching = true;
        else if (a.crouching && crouchT < CROUCH_ON - 0.15) a.crouching = false;

        let want = 'idle';
        if (moving) {
          want = sr >= SPRINT_THRESHOLD ? 'sprint' : sr >= RUN_THRESHOLD ? 'run' : 'walk';
        }

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
          a.motionState === 'sprint'
            ? CLIP.sprint
            : a.motionState === 'run'
            ? CLIP.run
            : a.motionState === 'walk'
            ? (a.crouching ? CLIP.crouchWalk : CLIP.walk)
            : (a.crouching ? CLIP.crouchIdle : CLIP.idle);

        // 蹲走速度慢一半，走路脚频跟着降，不然像在打滑
        let ts = 1;
        if (a.motionState === 'walk') ts = 0.7 + Math.min(1, sr) * 0.5;
        else if (a.motionState === 'run') ts = 0.8 + Math.min(1.2, sr) * 0.35;
        else if (a.motionState === 'sprint') ts = 0.9 + Math.min(1.2, sr) * 0.3;

        switchTo(a, clipName, {
          loop: true,
          timeScale: ts,
          force: !!a.needResume,
        });
        a.needResume = false;
      }
    }

    a.time += dt;
    a.mixer.update(dt);
  }

  /* ---------- 持枪动作组（第一人称化身 / 第三人称端枪角色共用） ---------- */

  /**
   * 只走「持枪」这一组 clip 的 locomotion。
   *
   * 为什么不能用 drive()：那一组是空手的 Walk / Run / Sprint，动作本身把
   * 手臂垂在身侧；第一人称裁掉身体后枪会整个掉出画面（见 tmp/fps-view/
   * p*_*.png 的对照），第三人称看着则是"端着枪却跑空手步"。持枪组
   * （AimIdle / RifleRun / RifleCrouchAim / ShootAuto）才是端枪在身前的姿势。
   *
   * 两个入口共用这份实现：
   * - driveRifle —— 第一人称化身（js/soldier.js 的 createArtViewModel）
   * - driveArmed —— 第三人称端枪角色（AI 小队，见 create 的 opts.armed）
   *
   * 状态：state.moving / speedRatio / ads(0..1) / onGround。
   * 蹲伏读 root.userData.crouchPose（与 drive 同一套）。
   */
  function driveRifle(root, dt, state) {
    const a = root.userData.glbAnim;
    if (!a) return null;
    state = state || {};
    dt = dt || 0.016;

    // 一次性动作（换弹 / 跳跃）计时：必须在 mixer.update 之前判断，结束帧立刻回落
    _advanceOnce(a, dt);

    // 跳跃中不抢 locomotion：jumpLoop 是 switchTo 切进去的（once 为空），
    // 不挡住的话滞空第一帧就会被 aimIdle 顶掉。
    if (!a.once && !a.dead && !a.jumpPhase) {
      const onGround = state.onGround !== false;
      const sr = state.speedRatio != null ? state.speedRatio : state.moving ? 1 : 0;
      const moving = !!state.moving && sr > 0.08 && onGround;
      const ads = (state.ads || 0) > 0.5;
      const crouchT = _crouchT(root, dt);
      if (!a.crouching && crouchT > CROUCH_ON) a.crouching = true;
      else if (a.crouching && crouchT < CROUCH_ON - 0.15) a.crouching = false;

      let want;
      if (a.firing) want = 'fire';
      else if (ads) want = 'ads';
      else if (a.crouching) want = moving ? 'move' : 'crouch';
      else want = moving ? 'move' : 'idle';

      // 滞回：枪在身前，动作互切比第三人称显眼得多（0.12s 就够）
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
        a.motionState === 'fire'
          ? CLIP.shootAuto
          : a.motionState === 'move'
          ? CLIP.rifleRun
          : a.motionState === 'crouch'
          ? CLIP.rifleCrouchAim
          : CLIP.aimIdle;

      // 走/跑时脚频跟着速度走，和 drive() 同一个思路
      let ts = 1;
      if (a.motionState === 'move') ts = 0.85 + Math.min(1.2, sr) * 0.35;
      else if (a.motionState === 'fire') ts = 1.25;

      switchTo(a, clipName, { loop: true, timeScale: ts, force: !!a.needResume });
      a.needResume = false;
    }

    a.time += dt;
    a.mixer.update(dt);
    // 必须在 mixer.update 之后：骨骼矩阵这一刻才是最新姿势
    if (a.armed) _alignHandGun(root, a);
    return a.motionState;
  }

  /**
   * 第三人称端枪角色的 locomotion（AI 小队默认走这条）。
   *
   * 与 driveRifle 同一套实现——都是端着枪的那组 clip；单独起名只是为了
   * 让调用点读起来分得清是第一人称 viewmodel 还是场上那个 AI。分工由
   * Soldier.updateLocomotion 按 root.userData.armed 决定（见 js/soldier.js）。
   */
  function driveArmed(root, dt, state) {
    return driveRifle(root, dt, state);
  }

  /**
   * 开火状态开关。**故意不做成 playOnce**：连射时每颗子弹都 reset 一次
   * 会把 ShootAuto 永远卡在第一帧；这里让它在开火期间循环播，
   * 扳机后坐交给 Player 的弹簧（_recoilKick）去做。
   */
  function setFiring(root, on) {
    const a = root.userData.glbAnim;
    if (!a) return;
    on = !!on;
    if (!!a.firing === on) return;
    a.firing = on;
    if (!a.once) a.needResume = true; // 强制下一次 switchTo 生效
  }

  global.VF = global.VF || {};
  global.VF.SoldierVoxel = {
    CLASS_MODELS: CLASS_MODELS,
    CLASS_IDS: CLASS_IDS,
    CLIP: CLIP,
    isValidClass: isValidClass,
    isReady: isReady,
    isAnyReady: isAnyReady,
    preload: preload,
    preloadAll: preloadAll,
    create: create,
    drive: drive,
    driveRifle: driveRifle,
    driveArmed: driveArmed,
    setFiring: setFiring,
    playOnce: playOnce,
    fire: fire,
    reload: reload,
    hit: hit,
    die: die,
    revive: revive,
    jump: jump,
  };

  // 注意：动作库约 1MB，不再启动即预载。由 preload()/preloadAll() 按需拉
  // （部署页开页时 preloadAll，PvP 远端化身由 pvp.js 触发 preload）。
})(window);
