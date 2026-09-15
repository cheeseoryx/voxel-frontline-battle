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
 * - VF.SoldierVoxel.create(classId, {team})  克隆出一个骨骼角色
 * - VF.SoldierVoxel.drive(root, dt, state)    每帧 locomotion（由 Soldier.updateLocomotion 委托）
 * - VF.SoldierVoxel.fire(root) / hit(root) / die(root) / jump(root, phase)
 *     一次性动作。播完自动回落到 locomotion；die 是终态，停在最后一帧。
 *
 * 由 VF.Soldier.createClassSoldier 在模型就绪时自动取用；未就绪时静默
 * 回退程序化盒子兵，加载完成后 next 帧重建即可换上。
 *
 * 资产约定（烘焙产物，见 scripts/bake-roles.js）：
 * - assets/characters/soldier01..04.glb   蒙皮网格，共用同一副 Bip001 骨架
 * - assets/characters/soldier_anims.glb   仅骨架 + 15 个 clip（见 CLIP）
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
  };
  // 缺这几个就不算就绪（站立与移动是硬需求）
  const REQUIRED_CLIPS = [CLIP.idle, CLIP.walk, CLIP.run];

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

    let muzzle = null;
    const gunBits = _mountBackWeapon(model, wrap, opts.weaponId);
    if (gunBits) muzzle = gunBits.muzzle;

    _addTeamMarker(root, team);

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

    // 防御「只创建不驱动」的消费者（PvP 远端化身曾因此渲染成 A-pose）
    switchTo(root.userData.glbAnim, CLIP.idle, { loop: true, fade: 0 });
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

  function drive(root, dt, state) {
    const a = root.userData.glbAnim;
    if (!a) return;
    state = state || {};
    dt = dt || 0.016;

    // 一次性动作计时（必须在 mixer.update 之前判断，这样结束帧立刻回落）
    if (a.once) {
      a.once.time += dt;
      if (a.once.time >= a.once.duration) {
        const hold = a.once.hold;
        a.once = null;
        if (!hold) {
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
      }
    }

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
