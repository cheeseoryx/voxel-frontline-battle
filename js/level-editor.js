/**
 * level-editor.js — 游戏内关卡编辑器（F8）。原 prop-editor.js。
 *
 * 自由相机 + 右侧分页面板。五个工具页：
 *
 *   摆件    .vox 烘焙资产（VF.PROP_MANIFEST），写 island-conquest-props.js
 *   预制体  程序化建筑（world.stampEditorPrefab）
 *   地形    高度笔刷
 *   材质    表面材质涂刷
 *   水域    水域 / 陆地轮廓覆盖
 *
 * 相机：  默认自由飞行（WASD 沿视线飞，抬头+W 上升；Shift 加速、Ctrl 减速、
 *         按住右键拖动转视角、滚轮调速度）；按 G 切第一人称行走看效果。
 * 保存：  Ctrl+S 写所有脏文件（File System Access API 直写源文件）。
 *
 * ── 两条写入通道（这是本模块的核心设计约束）─────────────────────────────
 *
 * 增量：地形高度、表面材质。走 world.setTerrainTop / 直接改 groundY 那一层的
 *       块，然后一次 world.dirtyRect。拖着刷不卡。
 * 全量：摆件、预制体、水域轮廓。走 world.regenerate(seed) 重建整个 1024×1024
 *       世界，一次操作 ~数百毫秒。
 *
 * 为什么后三者必须全量：摆件和预制体写进体素网格不可逆；水域轮廓改变
 * _buildHeightTerrain 的 wet/playable 分支、浅水 InstancedMesh、道路和小镇
 * 布局，只能重新生成。面板上对这三项有明确标注，否则用户会以为卡了。
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};
  if (global.VF._levelEditorMounted) return;
  global.VF._levelEditorMounted = true;

  const MAP_KEY = 'island-conquest';
  const STORAGE_KEY = 'vf_prop_layout_v1';

  /**
   * 工具页。'prop' 取代了原来的 'place'（含义不变：正在放摆件）。
   * 'none' = 只看不改，左键点场景 = 选中已摆摆件。
   */
  const TABS = [
    { id: 'prop', label: '摆件', bucket: 'full' },
    { id: 'prefab', label: '预制体', bucket: 'full' },
    { id: 'height', label: '地形', bucket: 'inc' },
    { id: 'material', label: '材质', bucket: 'inc' },
    { id: 'water', label: '水域', bucket: 'full' },
  ];

  const state = {
    active: false,
    mode: 'fly',          // 'fly' | 'walk'
    tab: 'prop',          // 当前面板页，见 TABS
    tool: 'none',         // 'none' | 'prop' | 'prefab' | 'height' | 'material' | 'water'
    placingId: null,      // 正在放置的资产 id（摆件页）
    placingKind: null,    // 正在放置的预制体 kind（预制体页）
    paintId: 0,           // 材质页选中的 VF.BLOCK id，0 = 橡皮
    contourValue: 1,      // 水域页：1 强制水 / 2 强制陆地 / 0 清除覆盖
    selectedIndex: -1,    // 选中摆件在 state.props 里的下标
    selectedPrefab: -1,   // 选中预制体在 state.prefabs 里的下标
    yaw: 0,
    props: [],            // { id, nx, nz, yaw }
    prefabs: [],          // { kind, nx, nz, yaw }
    dirty: false,
    cam: { x: 0, y: 0, z: 0, yaw: 0, pitch: -0.6 },
    speed: 30,
    keys: {},
    mouse: { x: 0, y: 0 },
    lookLocked: false,
    anim: null,           // 相机飞行动画
    ghost: null,
    ghostKey: '',
    selBox: null,
    selKey: '',
    zones: null,
    showZones: true,
    hud: null,
    statusEl: null,
    // 笔刷（地形 / 材质共用一套半径，各自记强度）
    brush: {
      radius: 12,         // 米
      strength: 1.5,      // 米/秒（高度笔刷）
      mode: 'raise',      // 'raise' | 'lower' | 'smooth' | 'flatten' | 'reset'
      ring: null,         // 贴地圆环指示器
      ringKey: '',
      painting: false,
      flattenTo: null,    // 'flatten' 模式按下时锁定的目标高度
    },
    undo: [],             // 笔画级撤销栈，见 pushUndo
    _lodFocusX: null,     // setLodFocus 距离节流
    _lodFocusZ: null,
    _bound: false,
    _wasRunning: false,
  };

  /** 当前页属于哪条写入通道（'inc' 增量 / 'full' 全量重建）。 */
  function tabBucket(tab) {
    for (let i = 0; i < TABS.length; i++) if (TABS[i].id === tab) return TABS[i].bucket;
    return 'full';
  }

  /**
   * 程序化预制体。尺寸抄自 voxel-world.stampEditorPrefab（:3696-3745），只用于
   * 面板显示和 ghost —— 真正的落地尺寸由那个函数返回。
   */
  const PREFABS = [
    { kind: 'house', label: '民房', w: 14, d: 12, h: 8, rotatable: true },
    { kind: 'midrise', label: '多层楼', w: 13, d: 13, h: 18, rotatable: false },
    { kind: 'skyscraper', label: '摩天楼', w: 16, d: 16, h: 48, rotatable: false },
    { kind: 'ruin', label: '废墟', w: 10, d: 10, h: 6, rotatable: false },
    { kind: 'factory', label: '工厂', w: 40, d: 28, h: 16, rotatable: true },
    { kind: 'bridge', label: '高架桥', w: 36, d: 8, h: 20, rotatable: true },
  ];

  function prefabDef(kind) {
    for (let i = 0; i < PREFABS.length; i++) if (PREFABS[i].kind === kind) return PREFABS[i];
    return null;
  }

  /** 表面材质调色板（材质页）。id 0 是橡皮，还原程序材质。 */
  function materialPalette() {
    const B = global.VF.BLOCK || {};
    return [
      { id: 0, label: '还原程序材质' },
      { id: B.GRASS, label: '草地' },
      { id: B.DIRT, label: '沙土' },
      { id: B.STONE, label: '石头' },
      { id: B.RUBBLE, label: '碎石' },
      { id: B.ASPHALT, label: '沥青' },
      { id: B.ROAD, label: '路面' },
      { id: B.CONCRETE, label: '混凝土' },
    ];
  }

  function game() {
    return global.VF && global.VF.game;
  }
  function world() {
    const g = game();
    return g && g.world;
  }
  function manifest() {
    return global.VF.PROP_MANIFEST || [];
  }
  function propDef(id) {
    return global.VF.PROPS && global.VF.PROPS[id];
  }
  function footprintFor(id, yaw) {
    const p = propDef(id);
    if (!p) return { w: 8, d: 8, h: 6 };
    const rot = ((yaw % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;
    return { w: swap ? p.d : p.w, d: swap ? p.w : p.d, h: p.h };
  }

  /* ------------------------------------------------------------------ *
   * 布局存储（localStorage 草稿）
   *
   * 草稿只覆盖摆件和预制体。**地形不进草稿** —— 三层 256² 网格 JSON 化有几百 KB，
   * 每笔都写会卡；而且地形丢一笔改动的代价远低于让编辑器每次拖动都卡一下。地形
   * 未保存就退出编辑器会提示，且世界回滚到源文件状态。
   *
   * v:2 起 payload 多了 prefabs 字段。v:1 的旧草稿仍能读（prefabs 视为空）。
   * ------------------------------------------------------------------ */
  function readLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.props)) return null;
      return {
        props: data.props,
        prefabs: Array.isArray(data.prefabs) ? data.prefabs : [],
      };
    } catch (_) {
      return null;
    }
  }
  function writeLayout() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ v: 2, map: MAP_KEY, props: state.props, prefabs: state.prefabs })
      );
    } catch (_) {}
  }
  function clearLayout() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  /** 源文件里当前生效的布局（world 就是按它生成的）。 */
  function savedLayout() {
    return (global.VF.MAP_PROPS && global.VF.MAP_PROPS[MAP_KEY]) || [];
  }
  function savedPrefabs() {
    return (global.VF.MAP_PREFABS && global.VF.MAP_PREFABS[MAP_KEY]) || [];
  }

  /** 两份布局是否等价——决定进编辑器时要不要重建世界。 */
  function sameLayout(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const p = a[i];
      const q = b[i];
      const pk = p.id != null ? p.id : p.kind;
      const qk = q.id != null ? q.id : q.kind;
      if (pk !== qk || (p.yaw || 0) !== (q.yaw || 0)) return false;
      if (Math.abs(p.nx - q.nx) > 1e-6 || Math.abs(p.nz - q.nz) > 1e-6) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 地形覆盖层（增量通道）
   *
   * VF.MapTerrain 持有一份 live 数据（Int16Array/Uint8Array），笔刷直接改它。
   * 采样也读同一份 —— 所以 island.heightAtMeters() 立刻反映笔刷结果，编辑器预览
   * 和刷新后加载走的是同一个函数，不会错位。
   * ------------------------------------------------------------------ */
  function mapTerrain() {
    return global.VF.MapTerrain || null;
  }

  /** 当前草稿态的地形覆盖数据；MapTerrain 没加载就返回 null（工具自动禁用）。 */
  function draftTerrain() {
    const MT = mapTerrain();
    return MT ? MT.get(MAP_KEY) : null;
  }

  function islandMap() {
    return global.VF.IslandConquestMap;
  }

  /**
   * 把一片 1m 世界范围的地形重刷成 heightAtMeters() 当前给出的值。
   *
   * 这是增量通道的落地点：改完控制点之后，只有被双线性影响到的格子需要重算。
   * 逐格 setTerrainTop({deferDirty:true}) 再统一 dirtyRect —— 和
   * terrain-fine.deformTerrainCircle 一样的骨架。
   *
   * protect:false 是必需的：_terrainCellProtected 会拒绝基地 34m、旗点 29m、
   * buildings footprint、摆件 claim 里的所有格子，加起来是地图的一大半，
   * 编辑器不绕过它就等于刷不动。
   */
  function repaintHeightBox(box) {
    const w = world();
    const map = islandMap();
    if (!box || !w || !map || !w.setTerrainTop) return 0;
    const size = w.worldSize;
    const x0 = Math.max(1, Math.floor(box.x0));
    const x1 = Math.min(size - 2, Math.ceil(box.x1));
    const z0 = Math.max(1, Math.floor(box.z0));
    const z1 = Math.min(size - 2, Math.ceil(box.z1));
    let changed = 0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const target = map.heightAtMeters(x, z, size);
        if (w.setTerrainTop(x, z, target, { deferDirty: true, protect: false })) changed++;
      }
    }
    if (w.dirtyRect) w.dirtyRect(x0 - 1, z0 - 1, x1 + 1, z1 + 1, 'content');
    return changed;
  }

  /**
   * 重刷一片范围的表面材质。
   *
   * 只改**恰好在 groundY 那一层**的块。写在 groundY 以下会踩 _isTerrainFill
   * 陷阱（voxel-world.js:2699）：那样的块既不可破坏、也不会被网格化器画出来。
   * 10cm 高度场的网格化器读的正是 get(ix, groundY, iz)（terrain-fine.js:460），
   * 所以改这一格就足够上色。
   */
  function repaintMaterialBox(box) {
    const w = world();
    const MT = mapTerrain();
    const data = draftTerrain();
    if (!box || !w || !data || !w.set) return 0;
    const B = global.VF.BLOCK || {};
    const size = w.worldSize;
    const x0 = Math.max(1, Math.floor(box.x0));
    const x1 = Math.min(size - 2, Math.ceil(box.x1));
    const z0 = Math.max(1, Math.floor(box.z0));
    const z1 = Math.min(size - 2, Math.ceil(box.z1));
    let changed = 0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        // 摆件/预制体的地基不该被地形材质盖掉。
        if (w.isPropClaimed && w.isPropClaimed(x, z)) continue;
        const gy = w.groundY ? w.groundY[z * size + x] : (w._surface ? w._surface(x, z) : 0);
        if (!(gy > 0)) continue;
        const cur = w.get(x, gy, z);
        // 结构体（混凝土墙基、路面之外的建筑）不覆盖；水面也不动。
        if (cur === B.BEDROCK || cur === B.WATER || cur === B.AIR) continue;
        const ov = MT.matAt(data, x, z);
        const want = ov || naturalSurfaceAt(x, z);
        if (want && want !== cur) {
          w.set(x, gy, z, want);
          changed++;
        }
      }
    }
    if (w.dirtyRect) w.dirtyRect(x0 - 1, z0 - 1, x1 + 1, z1 + 1, 'content');
    return changed;
  }

  /**
   * 程序化地形在该格本来会用的表面材质 —— 材质笔刷的「橡皮」要还原成这个。
   *
   * 这段逻辑是 voxel-world._buildHeightTerrain 的 desert 分支（:522-537）的镜像。
   * 复制而非复用：那段在生成循环内联着 gy/noise，抽出来要改 voxel-world 的公开
   * 面。两边都只依赖 (gy, _noise)，所以只要 desert 分支不动就不会漂。
   */
  function naturalSurfaceAt(x, z) {
    const w = world();
    const B = global.VF.BLOCK || {};
    if (!w) return B.DIRT;
    const size = w.worldSize;
    const gy = w.groundY ? w.groundY[z * size + x] : 0;
    const map = islandMap();
    const playable = map && map.isLand ? map.isLand(x, z, size) : true;
    const wet = map && map.isWater ? map.isWater(x, z, size) : false;
    if (!playable) return gy > 38 ? B.STONE : B.RUBBLE;
    if (wet) return B.DIRT;
    const n = w._noise ? w._noise(x * 0.11, z * 0.11) : 0.5;
    if (gy < 14) return n > 0.72 ? B.GRASS : B.DIRT;
    if (gy < 22) return n > 0.55 ? B.RUBBLE : B.DIRT;
    return n > 0.6 ? B.STONE : B.RUBBLE;
  }

  /* ------------------------------------------------------------------ *
   * 全量重建
   * ------------------------------------------------------------------ */
  /**
   * 全量重建：把给定的摆件/预制体列表临时挂进 VF.MAP_PROPS / VF.MAP_PREFABS，
   * 跑一次 world.regenerate(seed)，再还原全局。
   *
   * 临时替换是因为 VF.MAP_PROPS / VF.MAP_PREFABS 是生成器**唯一**的输入通道
   * （island.stamp 从那里读）。
   *
   * 地形覆盖层不用替换 —— VF.MapTerrain 的 live 数据本身就是编辑器改的那一份，
   * heightAtMeters 直接读它，所以重建时自动带上当前草稿的地形。
   */
  function regenerateWith(list, prefabList) {
    const w = world();
    const g = game();
    if (!w || !w.regenerate) return false;
    const seed = g && g.mapSeed != null ? g.mapSeed >>> 0 : (w.mapSeed || 0);
    const prevProps = global.VF.MAP_PROPS ? global.VF.MAP_PROPS[MAP_KEY] : undefined;
    global.VF.MAP_PREFABS = global.VF.MAP_PREFABS || {};
    const prevPrefabs = global.VF.MAP_PREFABS[MAP_KEY];
    if (global.VF.MAP_PROPS) global.VF.MAP_PROPS[MAP_KEY] = list;
    if (prefabList) global.VF.MAP_PREFABS[MAP_KEY] = prefabList;
    try {
      w.regenerate(seed);
    } finally {
      if (global.VF.MAP_PROPS) global.VF.MAP_PROPS[MAP_KEY] = prevProps;
      global.VF.MAP_PREFABS[MAP_KEY] = prevPrefabs;
    }
    if (g && g.bases && g.bases.rebuildAfterMapGen) g.bases.rebuildAfterMapGen();
    if (global.VF.UI && global.VF.UI.invalidateWorldMapCache) global.VF.UI.invalidateWorldMapCache();
    // 重建把 LOD 焦点也重置了，让下一帧 streamAround 重新设一次。
    state._lodFocusX = null;
    state._lodFocusZ = null;
    return true;
  }

  function rebuildEditor() {
    regenerateWith(state.props.slice(), state.prefabs.slice());
    state.dirty = true;
    writeLayout();
    rebuildZones();
    syncHud();
  }

  function rebuildSaved() {
    // 地形也要回滚 —— 否则未保存的地形改动会留在正常对局里。
    const MT = mapTerrain();
    if (MT) MT.reset(MAP_KEY);
    regenerateWith(savedLayout().slice(), savedPrefabs().slice());
  }

  /* ------------------------------------------------------------------ *
   * 射线 / 拾取
   * ------------------------------------------------------------------ */
  function currentRay() {
    const g = game();
    if (!g || !g.camera || !global.THREE) return null;
    const cam = g.camera;
    const locked = state.lookLocked || state.mode === 'walk' || document.pointerLockElement;
    let nx = 0;
    let ny = 0;
    if (!locked) {
      const el = g.renderer && g.renderer.domElement;
      const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
      nx = ((state.mouse.x - rect.left) / rect.width) * 2 - 1;
      ny = -(((state.mouse.y - rect.top) / rect.height) * 2 - 1);
    }
    const ndc = new global.THREE.Vector2(nx, ny);
    const rc = new global.THREE.Raycaster();
    rc.setFromCamera(ndc, cam);
    return { origin: rc.ray.origin.clone(), dir: rc.ray.direction.clone() };
  }

  function groundPoint() {
    const ray = currentRay();
    if (!ray) return null;
    const w = world();
    if (w && w.raycastTerrain) {
      const hit = w.raycastTerrain(ray.origin, ray.dir, 400);
      if (hit && hit.point) return { x: hit.point.x, z: hit.point.z };
    }
    return null;
  }

  /**
   * 摆件在世界里的 AABB。
   *
   * gy 取 footprint 内 _surface 的**最大值**，和 VF.Props.stamp
   * （js/props/prop-stamp.js:65-87）保持一致 —— 那里刻意用最大值而不是中心
   * 采样，否则上坡侧的地形会盖住模型下部。这里跟着用最大值，选中框才不会在
   * 斜坡上比实际摆件矮一截。
   */
  function worldBoxOf(p) {
    const w = world();
    const size = (w && w.worldSize) || 1024;
    const fp = footprintFor(p.id, p.yaw);
    const cx = p.nx * size;
    const cz = p.nz * size;
    const ox = Math.floor(cx) - (fp.w >> 1);
    const oz = Math.floor(cz) - (fp.d >> 1);
    const surfaceAt = function (x, z) {
      return (w && w._surface ? w._surface(x, z) : 9) || 9;
    };
    let gy = surfaceAt(Math.floor(cx), Math.floor(cz));
    for (let dz = 0; dz < fp.d; dz++) {
      for (let dx = 0; dx < fp.w; dx++) {
        const x = ox + dx;
        const z = oz + dz;
        if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
        const s = surfaceAt(x, z);
        if (s > gy) gy = s;
      }
    }
    // stamp 的两侧钳位：模型不能顶穿世界高度。
    const worldH = (w && w.height) || 101;
    const maxGy = worldH - fp.h - 4;
    if (maxGy >= 1 && gy > maxGy) gy = maxGy;
    return {
      ox: ox, oz: oz, w: fp.w, d: fp.d, h: fp.h,
      cx: cx, cz: cz, gy: gy,
    };
  }

  function pickPropIndex() {
    const ray = currentRay();
    const w = world();
    if (!ray || !w || !w._rayBoxDist) return -1;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < state.props.length; i++) {
      const b = worldBoxOf(state.props[i]);
      const box = {
        min: { x: b.ox, y: b.gy + 1, z: b.oz },
        max: { x: b.ox + b.w, y: b.gy + 1 + b.h, z: b.oz + b.d },
      };
      const t = w._rayBoxDist(ray.origin, ray.dir, box, 400);
      if (t != null && t < bestDist) {
        bestDist = t;
        best = i;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 相机
   * ------------------------------------------------------------------ */
  function initCam() {
    const g = game();
    if (g && g.player && g.player.getEyePosition) {
      const eye = g.player.getEyePosition();
      state.cam.x = eye.x;
      state.cam.y = eye.y + 25;
      state.cam.z = eye.z;
      state.cam.yaw = g.player.yaw || 0;
      state.cam.pitch = -0.6;
    }
  }

  function applyCamera() {
    const g = game();
    if (!g || !g.camera || !global.THREE) return;
    if (state.mode !== 'fly') return; // walk 让 player 写相机
    g.camera.position.set(state.cam.x, state.cam.y, state.cam.z);
    const e = new global.THREE.Euler(state.cam.pitch, state.cam.yaw, 0, 'YXZ');
    g.camera.quaternion.setFromEuler(e);
  }

  /**
   * 以相机（或行走时的角色）为中心流送区块。
   *
   * setLodFocus 也在这里调，但**必须节流**：它会遍历全部 4096 个 chunkMesh 重
   * 评 LOD（voxel-world.js:3226），每帧调会直接吃掉一帧。不调的后果是地形 LOD
   * 焦点留在玩家最后站的地方，飞到远处雕地形时是在 1m 粗网格上作业 —— 看不见
   * 10cm 的实际结果。24m 差不多是一个 fine LOD 区块半径。
   */
  const LOD_FOCUS_STEP = 24;

  function streamAround(x, z) {
    const w = world();
    if (!w) return;
    if (w.flushRebuilds) w.flushRebuilds(6, x, z);
    if (w.ensureMeshedAround) w.ensureMeshedAround(x, z, 8);
    if (w.updateChunkVisibility) w.updateChunkVisibility(x, z, 340);
    if (w.setLodFocus) {
      const moved =
        state._lodFocusX == null ||
        Math.abs(x - state._lodFocusX) > LOD_FOCUS_STEP ||
        Math.abs(z - state._lodFocusZ) > LOD_FOCUS_STEP;
      if (moved) {
        state._lodFocusX = x;
        state._lodFocusZ = z;
        w.setLodFocus(Math.floor(x), Math.floor(z));
      }
    }
  }

  function moveFlyCam(dt) {
    const k = state.keys;
    const sp = state.speed *
      (k['ShiftLeft'] || k['ShiftRight'] ? 4 : 1) *
      (k['ControlLeft'] || k['ControlRight'] ? 0.25 : 1);
    const euler = new global.THREE.Euler(state.cam.pitch, state.cam.yaw, 0, 'YXZ');
    const fwd = new global.THREE.Vector3(0, 0, -1).applyEuler(euler);
    let dx = 0;
    let dy = 0;
    let dz = 0;
    if (k['KeyW']) { dx += fwd.x; dy += fwd.y; dz += fwd.z; }
    if (k['KeyS']) { dx -= fwd.x; dy -= fwd.y; dz -= fwd.z; }
    const rightX = Math.cos(state.cam.yaw);
    const rightZ = -Math.sin(state.cam.yaw);
    if (k['KeyD']) { dx += rightX; dz += rightZ; }
    if (k['KeyA']) { dx -= rightX; dz -= rightZ; }
    const len = Math.hypot(dx, dy, dz);
    if (len > 0) {
      const s = sp * dt / len;
      state.cam.x += dx * s;
      state.cam.y += dy * s;
      state.cam.z += dz * s;
    }
    state.cam.y = Math.max(1, Math.min(500, state.cam.y));
    const size = (world() && world().worldSize) || 1024;
    state.cam.x = Math.max(2, Math.min(size - 2, state.cam.x));
    state.cam.z = Math.max(2, Math.min(size - 2, state.cam.z));
  }

  function yawPitchToward(dir) {
    return {
      yaw: Math.atan2(-dir.x, -dir.z),
      pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))),
    };
  }

  function startFlyTo(tx, ty, tz, lx, ly, lz) {
    const dx = lx - tx;
    const dy = ly - ty;
    const dz = lz - tz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const yp = yawPitchToward({ x: dx / len, y: dy / len, z: dz / len });
    state.anim = {
      t0: performance.now(),
      dur: 520,
      fx: state.cam.x, fy: state.cam.y, fz: state.cam.z,
      fyaw: state.cam.yaw, fpitch: state.cam.pitch,
      tx: tx, ty: ty, tz: tz, tyaw: yp.yaw, tpitch: yp.pitch,
    };
  }

  function tickAnim() {
    const a = state.anim;
    if (!a) return;
    const t = Math.min(1, (performance.now() - a.t0) / a.dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    state.cam.x = a.fx + (a.tx - a.fx) * e;
    state.cam.y = a.fy + (a.ty - a.fy) * e;
    state.cam.z = a.fz + (a.tz - a.fz) * e;
    state.cam.yaw = a.fyaw + (a.tyaw - a.fyaw) * e;
    state.cam.pitch = a.fpitch + (a.tpitch - a.fpitch) * e;
    if (t >= 1) state.anim = null;
  }

  function flyToProp(index) {
    const p = state.props[index];
    if (!p) return;
    if (state.mode !== 'fly') setMode('fly');
    const b = worldBoxOf(p);
    const tx = b.cx + b.w * 0.8;
    const ty = b.gy + 1 + b.h * 1.4;
    const tz = b.cz + b.d * 0.8;
    startFlyTo(tx, ty, tz, b.cx, b.gy + 1 + b.h * 0.5, b.cz);
  }

  /* ------------------------------------------------------------------ *
   * ghost + 选中框
   * ------------------------------------------------------------------ */
  function disposeMesh(obj) {
    if (!obj) return;
    const g = game();
    if (g && g.scene) g.scene.remove(obj);
    obj.traverse(function (c) {
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material.dispose) c.material.dispose();
    });
  }

  function buildBox(w, d, h, color, opacity) {
    const g = game();
    if (!g || !g.scene || !global.THREE) return null;
    const mat = new global.THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: opacity, depthWrite: false,
    });
    const edge = new global.THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: 0.9, depthWrite: false, wireframe: true,
    });
    const box = new global.THREE.Mesh(new global.THREE.BoxGeometry(w, h, d), mat);
    const wire = new global.THREE.Mesh(new global.THREE.BoxGeometry(w, h, d), edge);
    const root = new global.THREE.Group();
    root.add(box);
    root.add(wire);
    g.scene.add(root);
    return root;
  }

  /** 当前 ghost 应该显示的尺寸；没有在放置任何东西就返回 null。 */
  function ghostFootprint() {
    if (state.tool === 'prop' && state.placingId) {
      return footprintFor(state.placingId, state.yaw);
    }
    if (state.tool === 'prefab' && state.placingKind) {
      const def = prefabDef(state.placingKind);
      if (!def) return null;
      const rot = ((state.yaw % 360) + 360) % 360;
      const swap = def.rotatable && (rot === 90 || rot === 270);
      return { w: swap ? def.d : def.w, d: swap ? def.w : def.d, h: def.h };
    }
    return null;
  }

  function ghostKeyNow() {
    if (state.tool === 'prop') return 'prop:' + state.placingId + ':' + state.yaw;
    if (state.tool === 'prefab') return 'prefab:' + state.placingKind + ':' + state.yaw;
    return '';
  }

  function rebuildGhost() {
    disposeMesh(state.ghost);
    state.ghost = null;
    state.ghostKey = '';
    const fp = ghostFootprint();
    if (!fp) return;
    // 预制体用另一个色，和摆件区分开
    const color = state.tool === 'prefab' ? 0x8ee08e : 0x7ec8ff;
    state.ghost = buildBox(fp.w, fp.d, fp.h, color, 0.3);
    state.ghostKey = ghostKeyNow();
  }

  /* ------------------------------------------------------------------ *
   * 笔刷指示器（贴地圆环）
   *
   * **逐顶点贴地**，不是一个平面圆盘。用 RingGeometry + 整体设一个 Y 的做法在
   * 斜坡上会一半埋进土里一半悬空；更糟的是刷的过程中中心比边缘变化快
   * （smoothstep 衰减），于是抬升时环浮起来（离相机近 → 看着变大）、降低时环沉
   * 进地里 —— 看起来像笔刷坏了，其实地形是对的。
   *
   * 所以自己建一条环形三角带：SEGMENTS 对内外顶点，每帧按各自的世界 XZ 采一次
   * getTerrainTop。半径变了才重建索引；每帧只改 position 数组。
   * ------------------------------------------------------------------ */
  const RING_SEGMENTS = 72;
  /** 环带宽度（米）。太细在远处会闪，太粗在小半径时糊成饼。 */
  const RING_WIDTH = 0.7;
  /** 抬离地表，避开和地形的 z-fighting。 */
  const RING_LIFT = 0.25;
  /**
   * ringKey 现在只是"已经建过了"的标记。
   *
   * 旧实现把半径编进 key，所以拖滑杆时每帧重建一次几何体；现在顶点位置每帧都
   * 重算，几何体和半径无关了。exit() 会把 ringKey 清空，下次进编辑器重建。
   */
  const RING_KEY = 'v2';

  const BRUSH_TINT = {
    raise: 0x7ec8ff,
    lower: 0xffa040,
    smooth: 0xa0ffa0,
    flatten: 0xffd020,
    reset: 0xff6060,
    material: 0xc080ff,
  };

  /** 轮廓笔刷按刷的值变色：水=蓝、陆=土黄、清除=灰。 */
  const CONTOUR_TINT = {
    0: 0x909090,
    1: 0x3aa0ff,
    2: 0xc8a050,
  };

  function rebuildBrushRing() {
    disposeMesh(state.brush.ring);
    state.brush.ring = null;
    state.brush.ringKey = '';
    const g = game();
    const T = global.THREE;
    if (!g || !g.scene || !T) return;
    const mat = new T.MeshBasicMaterial({
      color: 0x7ec8ff, transparent: true, opacity: 0.6,
      depthWrite: false, side: T.DoubleSide,
    });
    // 顶点：每段两个（内、外），首尾各多一对把环闭合。
    const n = RING_SEGMENTS + 1;
    const pos = new Float32Array(n * 2 * 3);
    const idx = [];
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a = i * 2;
      const b = a + 2;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mesh = new T.Mesh(geo, mat);
    // 顶点已经是世界坐标，别让 frustum culling 拿一个空的 boundingSphere 判死。
    mesh.frustumCulled = false;
    g.scene.add(mesh);
    state.brush.ring = mesh;
    // 顶点位置每帧重算，几何体不随半径变 —— 建一次就够（拖半径滑杆时不重建）。
    state.brush.ringKey = RING_KEY;
  }

  /**
   * 笔刷页才显示圆环；非笔刷页隐藏。
   *
   * water 也算笔刷页 —— 它和 height/material 共用 state.brush.radius（Shift+滚轮
   * 那一段就是三页一起判的），少了它就变成"能调半径但看不见调的是多大"。
   */
  function updateBrushRing() {
    if (!state.active) return;
    const brushing = state.tool === 'height' || state.tool === 'material' ||
      state.tool === 'water';
    if (!brushing) {
      if (state.brush.ring) state.brush.ring.visible = false;
      return;
    }
    if (state.brush.ringKey !== RING_KEY) rebuildBrushRing();
    const ring = state.brush.ring;
    if (!ring) return;
    const pos = groundPoint();
    const w = world();
    if (!pos || !w || !ring.geometry) {
      ring.visible = false;
      return;
    }
    const attr = ring.geometry.getAttribute && ring.geometry.getAttribute('position');
    if (!attr) {
      ring.visible = false;
      return;
    }
    const arr = attr.array;
    const r = state.brush.radius;
    const rIn = Math.max(0.2, r - RING_WIDTH);
    const topAt = w.getTerrainTop
      ? function (x, z) { return w.getTerrainTop(x, z); }
      : function () { return 10; };
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const th = (i / RING_SEGMENTS) * Math.PI * 2;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const xi = pos.x + cs * rIn;
      const zi = pos.z + sn * rIn;
      const xo = pos.x + cs * r;
      const zo = pos.z + sn * r;
      let o = i * 6;
      arr[o] = xi;
      arr[o + 1] = topAt(xi, zi) + RING_LIFT;
      arr[o + 2] = zi;
      o += 3;
      arr[o] = xo;
      arr[o + 1] = topAt(xo, zo) + RING_LIFT;
      arr[o + 2] = zo;
    }
    attr.needsUpdate = true;
    ring.visible = true;
    let tint;
    if (state.tool === 'material') tint = BRUSH_TINT.material;
    else if (state.tool === 'water') {
      tint = CONTOUR_TINT[state.contourValue];
      if (tint == null) tint = CONTOUR_TINT[1];
    } else tint = BRUSH_TINT[state.brush.mode] || BRUSH_TINT.raise;
    if (ring.material && ring.material.color) ring.material.color.setHex(tint);
  }

  function updateGhost() {
    if (!state.active) return;
    if (state.ghostKey !== ghostKeyNow()) rebuildGhost();
    if (!state.ghost) return;
    const fp = ghostFootprint();
    const pos = groundPoint();
    const w = world();
    if (!fp || !pos || !w) {
      state.ghost.visible = false;
      return;
    }
    const gy = w._surface ? w._surface(Math.floor(pos.x), Math.floor(pos.z)) : 4;
    state.ghost.position.set(Math.floor(pos.x) + 0.5, gy + 1 + fp.h * 0.5, Math.floor(pos.z) + 0.5);
    state.ghost.visible = true;
    // 落在保护区就把 ghost 染黄，并在状态栏说明原因（不阻止放置）。
    const base = state.tool === 'prefab' ? 0x8ee08e : 0x7ec8ff;
    const warn = zoneWarningAt(pos.x, pos.z);
    const tint = warn ? 0xffd020 : base;
    state.ghost.traverse(function (c) {
      if (c.material && c.material.color) c.material.color.setHex(tint);
    });
    if (warn !== state._lastWarn) {
      state._lastWarn = warn;
      if (warn) setStatus('⚠ ' + warn + ' —— 会正常出现，但可能影响出兵/占点');
      else setStatus('左键放置 · Q 取消 · R 旋转');
    }
  }

  function rebuildSelBox() {
    disposeMesh(state.selBox);
    state.selBox = null;
    state.selKey = '';
    const p = state.props[state.selectedIndex];
    if (!p) return;
    const b = worldBoxOf(p);
    const fp = footprintFor(p.id, p.yaw);
    state.selBox = buildBox(fp.w, fp.d, fp.h, 0xffb020, 0.28);
    state.selBox.position.set(b.cx, b.gy + 1 + fp.h * 0.5, b.cz);
    state.selKey = state.selectedIndex + ':' + p.id + ':' + p.yaw;
  }

  function updateSelectionBox() {
    if (!state.active) return;
    const p = state.props[state.selectedIndex];
    const key = p ? (state.selectedIndex + ':' + p.id + ':' + p.yaw) : '';
    if (state.selKey !== key) rebuildSelBox();
  }

  /* ------------------------------------------------------------------ *
   * 保护区叠层
   *
   * 摆件现在优先于关卡逻辑（放了就一定出现），但摆进出闸通道 / 占领点广场
   * 仍然会挡住出兵或占点。这里把这些区域平铺出来，让美术自己判断。
   * ------------------------------------------------------------------ */
  function buildZonePlane(cx, cz, w, d, color, opacity) {
    const g = game();
    const wl = world();
    if (!g || !g.scene || !global.THREE || !wl) return null;
    const gy = wl._surface ? wl._surface(Math.floor(cx), Math.floor(cz)) : 4;
    const mat = new global.THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: opacity,
      depthWrite: false, side: global.THREE.DoubleSide,
    });
    const mesh = new global.THREE.Mesh(new global.THREE.PlaneGeometry(w, d), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, gy + 1.5, cz);
    g.scene.add(mesh);
    return mesh;
  }

  function rebuildZones() {
    if (state.zones) {
      for (let i = 0; i < state.zones.length; i++) disposeMesh(state.zones[i]);
    }
    state.zones = [];
    const wl = world();
    if (!wl || !state.showZones) return;

    // 基地核心 + 出闸通道（对应 voxel-world.js _isBaseKeepClear 的常量）
    const bases = wl._plannedBases || [];
    for (let i = 0; i < bases.length; i++) {
      const b = bases[i];
      const core = buildZonePlane(b.x, b.z, 24, 24, 0xff4040, 0.22);
      if (core) state.zones.push(core);
      const half = 27;
      const len = 75;
      let cx = b.x;
      let cz = b.z;
      let cw = half * 2;
      let cd = len;
      if (b.gate === '+z') cz = b.z + len / 2;
      else if (b.gate === '-z') cz = b.z - len / 2;
      else if (b.gate === '+x') { cx = b.x + len / 2; cw = len; cd = half * 2; }
      else if (b.gate === '-x') { cx = b.x - len / 2; cw = len; cd = half * 2; }
      const corridor = buildZonePlane(cx, cz, cw, cd, 0xff8020, 0.16);
      if (corridor) state.zones.push(corridor);
    }

    // 占领点广场（_clearFlagPlaza 半径 24）
    const flags = wl._kitFlags || [];
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      const fx = f.x != null ? f.x : f.cx;
      const fz = f.z != null ? f.z : f.cz;
      const plaza = buildZonePlane(fx, fz, 48, 48, 0xffd020, 0.16);
      if (plaza) state.zones.push(plaza);
    }
  }

  /** 当前放置点是否落在保护区里 —— 只用于提示，不阻止放置。 */
  function zoneWarningAt(x, z) {
    const wl = world();
    if (!wl) return '';
    const bases = wl._plannedBases || [];
    for (let i = 0; i < bases.length; i++) {
      const b = bases[i];
      if (Math.abs(x - b.x) < 12 && Math.abs(z - b.z) < 12) return '基地核心';
      const half = 27;
      const len = 75;
      if (b.gate === '+z' && Math.abs(x - b.x) <= half && z >= b.z && z <= b.z + len) return '出闸通道';
      if (b.gate === '-z' && Math.abs(x - b.x) <= half && z <= b.z && z >= b.z - len) return '出闸通道';
      if (b.gate === '+x' && Math.abs(z - b.z) <= half && x >= b.x && x <= b.x + len) return '出闸通道';
      if (b.gate === '-x' && Math.abs(z - b.z) <= half && x <= b.x && x >= b.x - len) return '出闸通道';
    }
    const flags = wl._kitFlags || [];
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      const fx = f.x != null ? f.x : f.cx;
      const fz = f.z != null ? f.z : f.cz;
      const dx = x - fx;
      const dz = z - fz;
      if (dx * dx + dz * dz <= 24 * 24) return '占领点广场' + (f.letter ? ' ' + f.letter : '');
    }
    return '';
  }

  /* ------------------------------------------------------------------ *
   * 放置 / 选中 / 删除 / 旋转
   * ------------------------------------------------------------------ */
  function placeAt() {
    const pos = groundPoint();
    const w = world();
    if (!pos || !w) return;
    const size = w.worldSize;
    const nx = Math.max(0, Math.min(1, Math.floor(pos.x) / size));
    const nz = Math.max(0, Math.min(1, Math.floor(pos.z) / size));

    if (state.tool === 'prop') {
      if (!state.placingId) return;
      const dup = state.props.some(function (p) {
        return p.id === state.placingId &&
          Math.abs(p.nx - nx) < 0.0005 && Math.abs(p.nz - nz) < 0.0005;
      });
      if (dup) {
        toast('这里已经有 ' + state.placingId + ' 了');
        return;
      }
      state.props.push({ id: state.placingId, nx: nx, nz: nz, yaw: state.yaw });
      rebuildEditor();
      return;
    }

    if (state.tool === 'prefab') {
      if (!state.placingKind) return;
      const dup = state.prefabs.some(function (p) {
        return p.kind === state.placingKind &&
          Math.abs(p.nx - nx) < 0.0005 && Math.abs(p.nz - nz) < 0.0005;
      });
      if (dup) {
        toast('这里已经有' + ((prefabDef(state.placingKind) || {}).label || state.placingKind) + '了');
        return;
      }
      state.prefabs.push({ kind: state.placingKind, nx: nx, nz: nz, yaw: state.yaw });
      rebuildEditor();
    }
  }

  function selectAt() {
    const idx = pickPropIndex();
    state.selectedIndex = idx;
    state.selectedPrefab = -1;
    if (idx >= 0) setStatus('已选中 ' + state.props[idx].id);
    syncHud();
  }

  function deleteSelected() {
    if (state.selectedPrefab >= 0) {
      const removed = state.prefabs.splice(state.selectedPrefab, 1)[0];
      state.selectedPrefab = -1;
      rebuildEditor();
      toast('已删除' + ((prefabDef(removed.kind) || {}).label || removed.kind));
      return;
    }
    if (state.selectedIndex < 0) return;
    const removed = state.props.splice(state.selectedIndex, 1)[0];
    state.selectedIndex = -1;
    rebuildEditor();
    toast('已删除 ' + removed.id);
  }

  function rotateBy(dir) {
    const spin = function (v) {
      return ((v + dir * 90) % 360 + 360) % 360;
    };
    if ((state.tool === 'prop' && state.placingId) ||
        (state.tool === 'prefab' && state.placingKind)) {
      state.yaw = spin(state.yaw);
      rebuildGhost();
    } else if (state.selectedPrefab >= 0) {
      const p = state.prefabs[state.selectedPrefab];
      p.yaw = spin(p.yaw || 0);
      rebuildEditor();
    } else if (state.selectedIndex >= 0) {
      const p = state.props[state.selectedIndex];
      p.yaw = spin(p.yaw || 0);
      rebuildEditor();
    }
  }

  function cancelCurrent() {
    if (state.tool !== 'none') {
      state.tool = 'none';
      state.placingId = null;
      state.placingKind = null;
      state.brush.painting = false;
      state.brush.flattenTo = null;
      rebuildGhost();
      updateBrushRing();
    } else if (state.selectedIndex >= 0 || state.selectedPrefab >= 0) {
      state.selectedIndex = -1;
      state.selectedPrefab = -1;
      rebuildSelBox();
    }
    syncHud();
  }

  /* ------------------------------------------------------------------ *
   * 笔刷
   *
   * 骨架照抄 terrain-fine.deformTerrainCircle：
   *   1. 改控制点（smoothstep 径向衰减）
   *   2. 重算被双线性影响到的 1m 格 → setTerrainTop(deferDirty)
   *   3. 一次 dirtyRect
   * ------------------------------------------------------------------ */

  /** smoothstep 衰减：中心 1、边缘 0，导数在两端都为 0（不会刷出硬边）。 */
  function falloffAt(dist, radius) {
    if (dist >= radius) return 0;
    const t = 1 - dist / radius;
    return t * t * (3 - 2 * t);
  }

  /**
   * 笔刷覆盖的控制点范围。控制点在世界 (gx*step, gz*step)，所以直接除 step；
   * 两端各放宽一格，让边缘控制点也参与衰减。
   */
  function brushCellRange(data, cx, cz, radius) {
    const step = data.step;
    return {
      gx0: Math.floor((cx - radius) / step) - 1,
      gx1: Math.ceil((cx + radius) / step) + 1,
      gz0: Math.floor((cz - radius) / step) - 1,
      gz1: Math.ceil((cz + radius) / step) + 1,
    };
  }

  /**
   * 笔刷改动控制点后，需要重算的 1m 世界范围。
   *
   * 比笔刷半径**大一个 step**：双线性让一个控制点影响它周围 ±step 的所有格子，
   * 只重算半径内的格子会在边缘留下一圈没跟上的地形（视觉上是一道台阶）。
   */
  function brushWorldBox(data, cx, cz, radius) {
    const pad = data.step + 1;
    return {
      x0: cx - radius - pad,
      z0: cz - radius - pad,
      x1: cx + radius + pad,
      z1: cz + radius + pad,
    };
  }

  /* ------------------------------------------------------------------ *
   * 笔画浮点累加器
   *
   * h 层存的是**分米整数**（Int16Array），而笔刷按帧累加：默认强度 1.5 m/s 在
   * 60fps 下一帧只有 0.25dm。直接 Math.round 写回去是 0，下一帧又从 0 算出
   * 0.25 —— 永远跨不过取整门槛，抬升/降低就是**完全没反应**。smooth/flatten/
   * reset 同病：它们每帧只朝目标收敛约 6%，差值不到 8dm 时每帧变化量 < 0.5dm。
   * 而且这个 bug 依赖帧率（30fps 恰好是 0.5dm 能刷，60fps 刷不动）。
   *
   * 所以一笔之内把精确值留在浮点里，取整只发生在写进 data.h 的那一刻。
   *
   * gen 是代际标记：开一笔只 ++id，不用每笔 fill 一个 25 万字节的 Float32Array。
   * ------------------------------------------------------------------ */
  const strokeAcc = { v: null, gen: null, n: 0, id: 0 };

  /** 开一笔。n = 控制点总数。 */
  function accBegin(n) {
    if (strokeAcc.n !== n) {
      strokeAcc.v = new Float32Array(n);
      strokeAcc.gen = new Int32Array(n);
      strokeAcc.n = n;
      strokeAcc.id = 0;
    }
    strokeAcc.id++;
    // Int32 回绕（要连刷 21 亿笔）—— 真到了就清一次 gen，别让旧标记撞上。
    if (strokeAcc.id >= 0x7ffffff0) {
      strokeAcc.gen.fill(0);
      strokeAcc.id = 1;
    }
  }

  /**
   * 这一笔里该控制点的精确浮点偏移（分米）。第一次碰到时从 data.h 播种 ——
   * 所以撤销、切页、reset 之后重新起笔都是从当前真实地形接着刷。
   */
  function accGet(data, gi) {
    if (strokeAcc.gen[gi] !== strokeAcc.id) {
      strokeAcc.gen[gi] = strokeAcc.id;
      strokeAcc.v[gi] = data.h[gi];
    }
    return strokeAcc.v[gi];
  }

  /** 该控制点上，程序地形（不含偏移）的高度 —— 'flatten'/'reset'/'smooth' 要用。 */
  function proceduralTopAt(x, z) {
    const w = world();
    const map = islandMap();
    const data = draftTerrain();
    if (!w || !map) return 0;
    const size = w.worldSize;
    const h = map.heightAtMeters(x, z, size);
    if (!data) return h;
    return h - mapTerrain().heightOffsetAt(data, x, z);
  }

  /**
   * 高度笔刷。dtSec 让强度是「米/秒」而不是「米/帧」—— 否则帧率高的机器刷得快。
   * 返回改动的控制点数（0 = 这一下**写回**了什么都没变，浮点进度仍然记着）。
   *
   * 精确偏移累加在 strokeAcc 的浮点里，data.h 只是它取整后的投影。见 accBegin
   * 上面那段注释 —— 少了这层，默认强度在 60fps 下每帧 0.25dm 会被取整吃干净。
   */
  function applyHeightBrush(cx, cz, dtSec) {
    const MT = mapTerrain();
    const data = draftTerrain();
    const w = world();
    if (!MT || !data || !w) return 0;

    // 声明要改数据了 —— 让 MapTerrain 的 isBlank 缓存失效（它在 heightAtMeters
    // 的热路径上，不失效的话第一笔之后采样还以为覆盖层是空的）。
    MT.touch(data);
    const radius = state.brush.radius;
    const mode = state.brush.mode;
    const step = data.step;
    const rng = brushCellRange(data, cx, cz, radius);
    // 每秒 strength 米 → 分米
    const amount = state.brush.strength * dtSec * 10;
    let touched = 0;

    for (let gz = rng.gz0; gz <= rng.gz1; gz++) {
      for (let gx = rng.gx0; gx <= rng.gx1; gx++) {
        const gi = MT.cellIndex(data, gx, gz);
        if (gi < 0) continue;
        const wx = gx * step;
        const wz = gz * step;
        const f = falloffAt(Math.hypot(wx - cx, wz - cz), radius);
        if (f <= 0) continue;

        const cur = accGet(data, gi);
        let next = cur;
        if (mode === 'raise') {
          next = cur + amount * f;
        } else if (mode === 'lower') {
          next = cur - amount * f;
        } else if (mode === 'reset') {
          // 朝 0 收敛 —— 回到纯程序地形
          next = cur * (1 - Math.min(1, f * dtSec * 4));
        } else if (mode === 'flatten') {
          // 目标高度在按下时锁定，拖动过程中不跟着光标变（否则会刷成斜面）
          const target = state.brush.flattenTo;
          if (target == null) continue;
          const wantOffset = (target - proceduralTopAt(wx, wz)) * 10;
          next = cur + (wantOffset - cur) * Math.min(1, f * dtSec * 4);
        } else if (mode === 'smooth') {
          // 3×3 邻域均值。邻域读**取整后的 data.h**（不是累加器）：那才是屏幕上
          // 真实的地形，而且省掉给整片邻域播种累加器。1cm 级的差异看不出来。
          // 用旧值采样让平滑依赖遍历顺序，但一笔要刷很多帧，顺序偏差被反复平均
          // 掉了 —— 换成双缓冲不值这个内存。
          let sum = 0;
          let n = 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const ni = MT.cellIndex(data, gx + dx, gz + dz);
              if (ni < 0) continue;
              sum += data.h[ni];
              n++;
            }
          }
          if (!n) continue;
          next = cur + (sum / n - cur) * Math.min(1, f * dtSec * 6);
        }

        // 累加器也要钳位，否则按住抬升不放会一路涨到 1e9，松手再降低时要等很久
        // 才回到可见范围。
        if (next < MT.H_MIN) next = MT.H_MIN;
        else if (next > MT.H_MAX) next = MT.H_MAX;
        strokeAcc.v[gi] = next;

        const clamped = MT.clampH(next);
        const old = data.h[gi];
        if (clamped === old) continue;
        noteCell(gi, old);
        data.h[gi] = clamped;
        touched++;
      }
    }

    if (!touched) return 0;
    const box = brushWorldBox(data, cx, cz, radius);
    noteBox(box.x0, box.z0, box.x1, box.z1);
    repaintHeightBox(box);
    state.dirty = true;
    return touched;
  }

  /**
   * 材质笔刷。paintId = 要刷的 VF.BLOCK id，0 = 橡皮（还原程序材质）。
   * 材质是离散值，没有渐变 —— 半径内直接覆盖。
   */
  function applyMaterialBrush(cx, cz, paintId) {
    const MT = mapTerrain();
    const data = draftTerrain();
    const w = world();
    if (!MT || !data || !w) return 0;

    MT.touch(data);
    const radius = state.brush.radius;
    const step = data.step;
    const rng = brushCellRange(data, cx, cz, radius);
    let touched = 0;

    for (let gz = rng.gz0; gz <= rng.gz1; gz++) {
      for (let gx = rng.gx0; gx <= rng.gx1; gx++) {
        const gi = MT.cellIndex(data, gx, gz);
        if (gi < 0) continue;
        const wx = gx * step;
        const wz = gz * step;
        if (Math.hypot(wx - cx, wz - cz) > radius) continue;
        const old = data.mat[gi];
        if (old === paintId) continue;
        noteCell(gi, old);
        data.mat[gi] = paintId;
        touched++;
      }
    }

    if (!touched) return 0;
    const box = brushWorldBox(data, cx, cz, radius);
    noteBox(box.x0, box.z0, box.x1, box.z1);
    repaintMaterialBox(box);
    state.dirty = true;
    return touched;
  }

  /**
   * 轮廓笔刷（水域 / 陆地）。**全量通道** —— 改完一下重建整个世界。
   *
   * 不能走增量：轮廓改变 _buildHeightTerrain 的 wet/playable 分支、浅水
   * InstancedMesh（_stampShallowWater 一次性建整张）、道路走线和小镇布局。
   * 所以这里是「点一下 = 刷一片 + 重建」，不是按住拖。
   */
  function applyContourBrush(cx, cz, value) {
    const MT = mapTerrain();
    const data = draftTerrain();
    if (!MT || !data) return 0;
    MT.touch(data);
    const radius = state.brush.radius;
    const step = data.step;
    const rng = brushCellRange(data, cx, cz, radius);
    let touched = 0;
    for (let gz = rng.gz0; gz <= rng.gz1; gz++) {
      for (let gx = rng.gx0; gx <= rng.gx1; gx++) {
        const gi = MT.cellIndex(data, gx, gz);
        if (gi < 0) continue;
        if (Math.hypot(gx * step - cx, gz * step - cz) > radius) continue;
        if (data.water[gi] === value) continue;
        data.water[gi] = value;
        touched++;
      }
    }
    if (!touched) return 0;
    state.dirty = true;
    // 轮廓改了，摆件可能落进水里被 Props.stamp 拒收 —— 一并重建。
    rebuildEditor();
    return touched;
  }

  /* ------------------------------------------------------------------ *
   * 撤销栈（笔画级）
   *
   * 一"笔"= 从鼠标按下到松开的整个拖动过程，不是每帧一条。地形/材质笔刷记录
   * 被改动的控制点旧值（`cells: [[gridIndex, oldValue], ...]`），撤销时还原控制
   * 点再重跑同一片 1m 格 —— 比存整片高度场便宜得多。
   *
   * 全量通道（摆件/预制体/水域）的撤销走各自的重建，不进这个栈。
   * ------------------------------------------------------------------ */
  const UNDO_LIMIT = 40;

  function beginStroke(layer) {
    state.undo.push({ layer: layer, cells: [], seen: Object.create(null), box: null });
    while (state.undo.length > UNDO_LIMIT) state.undo.shift();
    // 高度笔刷要在浮点里累加这一笔的进度，见 accBegin。
    if (layer === 'h') {
      const data = draftTerrain();
      if (data) accBegin(data.cells * data.cells);
    }
  }

  /**
   * 记一个控制点的原值。同一笔里同一个控制点只记第一次 —— 拖动时一个控制点会
   * 被反复经过，记后面的值就等于没撤销。
   */
  function noteCell(gi, oldValue) {
    const stroke = state.undo[state.undo.length - 1];
    if (!stroke || stroke.seen[gi] !== undefined) return;
    stroke.seen[gi] = 1;
    stroke.cells.push([gi, oldValue]);
  }

  /** 记这一笔影响到的 1m 世界范围，撤销时照着重刷。 */
  function noteBox(x0, z0, x1, z1) {
    const stroke = state.undo[state.undo.length - 1];
    if (!stroke) return;
    if (!stroke.box) {
      stroke.box = { x0: x0, z0: z0, x1: x1, z1: z1 };
      return;
    }
    const b = stroke.box;
    if (x0 < b.x0) b.x0 = x0;
    if (z0 < b.z0) b.z0 = z0;
    if (x1 > b.x1) b.x1 = x1;
    if (z1 > b.z1) b.z1 = z1;
  }

  /** 丢掉没改动任何东西的空笔画（比如在保护区上点了一下）。 */
  function endStroke() {
    const stroke = state.undo[state.undo.length - 1];
    if (stroke && !stroke.cells.length) state.undo.pop();
  }

  function canUndo() {
    return state.undo.length > 0;
  }

  function undoStroke() {
    // 按住左键时按 Ctrl+Z：先把这一笔收尾。不然 pop 掉的是正在画的那一笔，
    // 之后的 noteCell 会记到上一笔里去，把撤销栈搅乱。
    if (state.brush.painting) {
      state.brush.painting = false;
      state.brush.flattenTo = null;
      endStroke();
    }
    const stroke = state.undo.pop();
    if (!stroke) {
      setStatus('没有可撤销的操作');
      return;
    }
    const data = draftTerrain();
    if (!data) return;
    const grid = data[stroke.layer];
    if (!grid) return;
    mapTerrain().touch(data);
    for (let i = 0; i < stroke.cells.length; i++) {
      grid[stroke.cells[i][0]] = stroke.cells[i][1];
    }
    if (stroke.layer === 'h') repaintHeightBox(stroke.box);
    else if (stroke.layer === 'mat') repaintMaterialBox(stroke.box);
    state.dirty = true;
    syncHud();
    setStatus('已撤销一笔（还剩 ' + state.undo.length + ' 步）');
  }

  /* ------------------------------------------------------------------ *
   * 模式切换
   * ------------------------------------------------------------------ */
  function setAvatarVisible(visible) {
    const g = game();
    if (!g || !g.player) return;
    const p = g.player;
    if (p._weaponViewModel) p._weaponViewModel.visible = visible && p._heldMode !== 'build';
    if (p.buildViewModel) p.buildViewModel.visible = visible && p._heldMode === 'build';
  }

  function setMode(mode) {
    const g = game();
    if (!g) return;
    if (mode === state.mode) return;
    if (mode === 'walk') {
      const w = world();
      if (g.player) {
        const ix = Math.floor(state.cam.x);
        const iz = Math.floor(state.cam.z);
        const gy = w && w._surface ? w._surface(ix, iz) : 4;
        g.player.object.position.set(ix + 0.5, gy + 1, iz + 0.5);
        g.player.velocity.set(0, 0, 0);
        g.player.zipRide = null;
        if (w && w.setLodFocus) {
          w.setLodFocus(ix, iz);
          state._lodFocusX = ix;
          state._lodFocusZ = iz;
        }
        g.player.yaw = state.cam.yaw;
        g.player.pitch = 0;
        g.player.dead = false;
        g.player.alive = true;
        g.player.health = g.player.maxHealth || 100;
        if (g.player.setHeldMode) g.player.setHeldMode('build');
      }
      state.mode = 'walk';
      g.running = true;
      g.levelEditing = true;
      document.exitPointerLock && document.exitPointerLock();
      state.lookLocked = false;
    } else {
      if (g.player && g.player.getEyePosition) {
        const eye = g.player.getEyePosition();
        state.cam.x = eye.x;
        state.cam.y = eye.y + 25;
        state.cam.z = eye.z;
        state.cam.yaw = g.player.yaw || 0;
        state.cam.pitch = -0.6;
      }
      state.mode = 'fly';
      g.running = false;
      g.levelEditing = true;
    }
    setAvatarVisible(mode === 'walk');
    syncHud();
  }

  /* ------------------------------------------------------------------ *
   * 保存到源文件
   * ------------------------------------------------------------------ */
  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  /**
   * 摆件 + 预制体源文件。两个键写在同一个文件里 —— 它们都是"手工摆放的东西"，
   * 分两个文件只会多一次文件选择器和一份 index.html 脚本标签。
   */
  function buildPropSource() {
    const propRows = state.props
      .map(function (p) {
        return '    { id: ' + JSON.stringify(p.id) +
          ', nx: ' + round4(p.nx) +
          ', nz: ' + round4(p.nz) +
          ', yaw: ' + (p.yaw || 0) + ' },';
      })
      .join('\n');
    const prefabRows = state.prefabs
      .map(function (p) {
        return '    { kind: ' + JSON.stringify(p.kind) +
          ', nx: ' + round4(p.nx) +
          ', nz: ' + round4(p.nz) +
          ', yaw: ' + (p.yaw || 0) + ' },';
      })
      .join('\n');
    return (
      '/**\n' +
      ' * island-conquest-props.js — 荒盆的摆件与预制体布局。\n' +
      ' *\n' +
      ' * 由游戏内关卡编辑器（js/level-editor.js，F8）写入，勿手改。坐标为归一化\n' +
      ' * 0..1（nx/nz × worldSize），世界尺寸变了不用重摆。\n' +
      ' *\n' +
      ' * MAP_PROPS    烘焙的 .vox 摆件（VF.PROPS 里的 id）\n' +
      ' * MAP_PREFABS  程序化预制体（world.stampEditorPrefab 的 kind）\n' +
      ' *\n' +
      ' * yaw ∈ {0, 90, 180, 270}（体素网格只能 90° 旋转）。\n' +
      ' */\n' +
      '(function (g) {\n' +
      "  'use strict';\n" +
      '  g.VF = g.VF || {};\n' +
      '  g.VF.MAP_PROPS = g.VF.MAP_PROPS || {};\n' +
      '  g.VF.MAP_PREFABS = g.VF.MAP_PREFABS || {};\n' +
      '  g.VF.MAP_PROPS[' + JSON.stringify(MAP_KEY) + '] = [\n' +
      (propRows ? propRows + '\n' : '') +
      '  ];\n' +
      '  g.VF.MAP_PREFABS[' + JSON.stringify(MAP_KEY) + '] = [\n' +
      (prefabRows ? prefabRows + '\n' : '') +
      '  ];\n' +
      '})(typeof window !== "undefined" ? window : globalThis);\n'
    );
  }

  /**
   * RLE 数组渲染成源码。短的（未编辑的层就是 `[0, 65536]`）保持单行，长的每 16 个
   * 数字折一行 —— 一层最坏情况有几万个数字，单行没法 diff。
   */
  function rleSource(arr, indent) {
    if (!arr.length) return '[]';
    if (arr.length <= 16) return '[' + arr.join(', ') + ']';
    const out = ['['];
    for (let i = 0; i < arr.length; i += 16) {
      out.push(indent + '  ' + arr.slice(i, i + 16).join(', ') + ',');
    }
    out.push(indent + ']');
    return out.join('\n');
  }

  function buildTerrainSource() {
    const MT = mapTerrain();
    const data = draftTerrain();
    if (!MT || !data) return null;
    const raw = MT.toRaw(data);
    return (
      '/**\n' +
      ' * island-conquest-terrain.js — 荒盆的地形覆盖层。\n' +
      ' *\n' +
      ' * 由游戏内关卡编辑器（js/level-editor.js，F8）写入，勿手改。\n' +
      ' *\n' +
      ' * 这里存的是**在程序地形之上的偏移量**，不是完整地形。地形本体是\n' +
      ' * js/maps/island-conquest.js heightAtMeters() 的闭式解；这一层只记编辑器改动\n' +
      ' * 过的地方。采样和编解码全在 js/maps/map-terrain.js。\n' +
      ' *\n' +
      ' *   step   控制点间距（米）\n' +
      ' *   cells  控制网格边长（cells × step 应覆盖 worldSize）\n' +
      ' *   h      高度偏移 RLE，单位分米（10cm），行主序，双线性插值\n' +
      ' *   mat    表面材质覆盖 RLE，VF.BLOCK id，0 = 不覆盖，最近邻\n' +
      ' *   water  轮廓覆盖 RLE，0 继承 / 1 强制水 / 2 强制陆地，最近邻\n' +
      ' *\n' +
      ' * RLE 格式：[值, 连续个数, ...]。全零的一层就是 [0, cells*cells] 两个数字。\n' +
      ' */\n' +
      '(function (g) {\n' +
      "  'use strict';\n" +
      '  g.VF = g.VF || {};\n' +
      '  g.VF.MAP_TERRAIN = g.VF.MAP_TERRAIN || {};\n' +
      '  g.VF.MAP_TERRAIN[' + JSON.stringify(MAP_KEY) + '] = {\n' +
      '    step: ' + raw.step + ',\n' +
      '    cells: ' + raw.cells + ',\n' +
      '    h: ' + rleSource(raw.h, '    ') + ',\n' +
      '    mat: ' + rleSource(raw.mat, '    ') + ',\n' +
      '    water: ' + rleSource(raw.water, '    ') + ',\n' +
      '  };\n' +
      '})(typeof window !== "undefined" ? window : globalThis);\n'
    );
  }

  function downloadFallback(body, filename) {
    const blob = new Blob([body], { type: 'application/javascript;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(body);
    } catch (_) {}
    setStatus('已下载 ' + filename + '（当前浏览器不支持直接写入，需手动替换）');
  }

  /* ------------------------------------------------------------------ *
   * File System Access：一个目录句柄统一管两个源文件
   *
   * 用户选一次目录（showDirectoryPicker），props 和 terrain 都写到该目录下，
   * 一个句柄存在 IndexedDB 里，之后记住。DB 名沿用 vf-prop-editor-fs ——
   * 改名会让已有授权句柄失效。旧的「每文件一个句柄」key 已废弃，残留无害。
   * ------------------------------------------------------------------ */
  const HANDLE_DB = 'vf-prop-editor-fs';
  const HANDLE_STORE = 'handles';
  const DIR_KEY = 'island-conquest-source-dir';
  const FILES = {
    props: { name: 'island-conquest-props.js' },
    terrain: { name: 'island-conquest-terrain.js' },
  };
  let cachedDirHandle = null;

  function openHandleDB() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(HANDLE_STORE);
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }
  async function getStoredHandle(key) {
    try {
      const db = await openHandleDB();
      return await new Promise(function (resolve, reject) {
        const tx = db.transaction(HANDLE_STORE, 'readonly');
        const req = tx.objectStore(HANDLE_STORE).get(key);
        req.onsuccess = function () {
          resolve(req.result || null);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    } catch (_) {
      return null;
    }
  }
  async function storeHandle(key, handle) {
    try {
      const db = await openHandleDB();
      await new Promise(function (resolve) {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).put(handle, key);
        tx.oncomplete = resolve;
      });
    } catch (_) {}
  }
  async function deleteStoredHandle(key) {
    try {
      const db = await openHandleDB();
      await new Promise(function (resolve) {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).delete(key);
        tx.oncomplete = resolve;
      });
    } catch (_) {}
  }

  /** 选目录。取消抛 AbortError。 */
  async function pickDirectory() {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    await storeHandle(DIR_KEY, dir);
    cachedDirHandle = dir;
    // 清理旧的「每文件一个句柄」，避免残留让人误以为还在用旧路径。
    await deleteStoredHandle('island-conquest-props');
    await deleteStoredHandle('island-conquest-terrain');
    return dir;
  }

  /** 拿到目录句柄。forcePick 强制重选。取消抛 AbortError。 */
  async function resolveDirectory(forcePick) {
    let dir = forcePick ? null : (cachedDirHandle || (await getStoredHandle(DIR_KEY)));
    if (dir) {
      const perm = await dir.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        dir = null;
      }
    }
    if (!dir) dir = await pickDirectory();
    cachedDirHandle = dir;
    return dir;
  }

  /** 在目录里写一个文件。返回文件名，取消/失败回退下载返回 null。 */
  async function writeOne(dir, name, body) {
    try {
      const fileHandle = await dir.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(body);
      await writable.close();
      return name;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      console.warn('[level-editor] 直接写入失败，回退为下载：' + name, e);
      downloadFallback(body, name);
      return null;
    }
  }

  /**
   * Ctrl+S：保存所有改动。
   *
   * 摆件/预制体和地形两个源文件写到同一个目录里。第一次保存弹一次目录选择器，
   * 之后记住；地形全零时跳过它 —— 没必要为一个空覆盖层写文件（但目录已选定，
   * 之后地形有改动会写到同一目录）。
   */
  async function exportToFile(forcePick) {
    const MT = mapTerrain();
    const data = draftTerrain();
    const terrainDirty = !!(MT && data && !MT.isBlank(data));
    const written = [];

    // 浏览器不支持目录直写：整体走下载回退。
    if (!window.showDirectoryPicker) {
      downloadFallback(buildPropSource(), FILES.props.name);
      if (terrainDirty) {
        const body = buildTerrainSource();
        if (body) downloadFallback(body, FILES.terrain.name);
      }
      setStatus('已下载（当前浏览器不支持直接写入，需手动替换）');
      return;
    }

    setStatus('保存中…');
    let dir;
    try {
      dir = await resolveDirectory(forcePick);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        setStatus('未保存（已取消）');
        return;
      }
      throw e;
    }

    const propName = await writeOne(dir, FILES.props.name, buildPropSource());
    if (propName) {
      if (global.VF.MAP_PROPS) global.VF.MAP_PROPS[MAP_KEY] = state.props.slice();
      global.VF.MAP_PREFABS = global.VF.MAP_PREFABS || {};
      global.VF.MAP_PREFABS[MAP_KEY] = state.prefabs.slice();
      written.push(propName);
    }

    if (terrainDirty) {
      const body = buildTerrainSource();
      if (body) {
        const terrainName = await writeOne(dir, FILES.terrain.name, body);
        if (terrainName) {
          // 固化成新的 raw，之后 reset() 回滚到的是刚保存的状态。
          MT.commit(MAP_KEY);
          written.push(terrainName);
        }
      }
    }

    if (!written.length) {
      setStatus('未保存（已取消）');
      return;
    }
    state.dirty = false;
    state.undo.length = 0;
    // 已经落盘，草稿使命完成——留着会在下次进编辑器时被当成"未保存改动"恢复。
    clearLayout();
    setStatus('已保存 ' + written.join('、') + '（' + new Date().toLocaleTimeString() + '）');
    syncHud();
  }

  /* ------------------------------------------------------------------ *
   * 面板
   * ------------------------------------------------------------------ */
  function toast(msg) {
    if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast(msg);
    else setStatus(msg);
  }
  function setStatus(msg) {
    if (state.statusEl) state.statusEl.textContent = msg || '';
  }

  function injectStyles() {
    if (document.getElementById('vf-prop-editor-style')) return;
    const css =
      '#vf-prop-editor-hud{position:fixed;right:14px;top:14px;bottom:14px;width:240px;' +
      'background:rgba(18,22,28,0.94);color:#d7e2ee;font:12px/1.5 system-ui,sans-serif;' +
      'border:1px solid #2a313c;border-radius:10px;z-index:1200;user-select:none;' +
      'display:flex;flex-direction:column;overflow:hidden;}' +
      '#vf-prop-editor-hud .pe-head{padding:10px 12px;border-bottom:1px solid #2a313c;}' +
      '#vf-prop-editor-hud .pe-title{font-weight:700;font-size:13px;color:#7ec8ff;}' +
      '#vf-prop-editor-hud .pe-mode{display:flex;gap:6px;margin-top:6px;}' +
      '#vf-prop-editor-hud .pe-mode button{flex:1;background:#2a313c;border:1px solid #3a424e;' +
      'color:#d7e2ee;border-radius:6px;padding:4px 0;cursor:pointer;font-size:12px;}' +
      '#vf-prop-editor-hud .pe-mode button.active{background:#1d4ed8;border-color:#3b82f6;color:#fff;}' +
      '#vf-prop-editor-hud .pe-speed{font-size:11px;color:#7ec8ff;margin-top:6px;}' +
      '#vf-prop-editor-hud .pe-speed span{color:#fff;font-weight:700;}' +
      '#vf-prop-editor-hud .pe-zones{display:flex;align-items:center;gap:5px;margin-top:6px;' +
      'font-size:11px;color:#9db0c4;cursor:pointer;}' +
      '#vf-prop-editor-hud .pe-scroll{flex:1;overflow-y:auto;padding:8px 10px;}' +
      '#vf-prop-editor-hud .pe-sec{margin:8px 0;font-weight:700;color:#9db0c4;font-size:11px;}' +
      '#vf-prop-editor-hud .pe-item{display:flex;align-items:center;gap:6px;background:#1f2530;' +
      'border:1px solid #2a313c;border-radius:6px;padding:5px 8px;margin:4px 0;cursor:pointer;}' +
      '#vf-prop-editor-hud .pe-item:hover{border-color:#3b82f6;}' +
      '#vf-prop-editor-hud .pe-item.active{background:#1d4ed8;border-color:#3b82f6;}' +
      '#vf-prop-editor-hud .pe-item.sel{background:#7c2d12;border-color:#f97316;}' +
      '#vf-prop-editor-hud .pe-item .pe-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '#vf-prop-editor-hud .pe-item .pe-sub{color:#7d8ea1;font-size:10px;}' +
      '#vf-prop-editor-hud .pe-item .pe-x{color:#f87171;padding:0 4px;border:none;background:none;' +
      'cursor:pointer;font-size:14px;line-height:1;}' +
      '#vf-prop-editor-hud .pe-foot{padding:8px 12px;border-top:1px solid #2a313c;}' +
      '#vf-prop-editor-hud .pe-actions{display:flex;gap:6px;margin-bottom:4px;}' +
      '#vf-prop-editor-hud .pe-save{flex:1;background:#166534;border:1px solid #22c55e;color:#fff;' +
      'border-radius:6px;padding:6px 0;cursor:pointer;font-weight:700;}' +
      '#vf-prop-editor-hud .pe-save-as{background:#2a313c;border:1px solid #3a424e;color:#d7e2ee;' +
      'border-radius:6px;padding:6px 8px;cursor:pointer;font-size:12px;white-space:nowrap;}' +
      '#vf-prop-editor-hud .pe-status{color:#9db0c4;font-size:11px;min-height:14px;}' +
      '#vf-prop-editor-hud .pe-kbd{display:inline-block;background:#2a313c;border:1px solid #3a424e;' +
      'border-radius:3px;padding:0 4px;margin:0 2px;font-size:10px;color:#aebdcc;}' +
      '#vf-prop-editor-hud .pe-help{margin:10px 0 2px;padding:8px;background:#14181f;' +
      'border:1px solid #2a313c;border-radius:6px;color:#9db0c4;font-size:10px;line-height:1.7;}' +
      // 工具页 tab：5 个挤在 240px 宽里，所以字号小、padding 窄、允许换行成两排
      '#vf-prop-editor-hud .pe-tabs{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;}' +
      '#vf-prop-editor-hud .pe-tabs button{flex:1 1 44px;background:#2a313c;border:1px solid #3a424e;' +
      'color:#d7e2ee;border-radius:5px;padding:4px 2px;cursor:pointer;font-size:11px;}' +
      '#vf-prop-editor-hud .pe-tabs button.active{background:#0e7490;border-color:#22d3ee;color:#fff;font-weight:700;}' +
      // 笔刷滑杆。滑杆读数**不能**靠 syncHud 刷新（整块 innerHTML 重建会打断拖动），
      // 所以数值有独立的 span id，input 事件里直接改 textContent。
      '#vf-prop-editor-hud .pe-slider{margin:8px 0;}' +
      '#vf-prop-editor-hud .pe-slider label{display:flex;justify-content:space-between;' +
      'font-size:11px;color:#9db0c4;margin-bottom:2px;}' +
      '#vf-prop-editor-hud .pe-slider label b{color:#fff;}' +
      '#vf-prop-editor-hud .pe-slider input[type=range]{width:100%;}' +
      // 通道提示条：全量重建的页要明确说"这会卡一下"
      '#vf-prop-editor-hud .pe-bucket{margin:4px 0 8px;padding:6px 8px;border-radius:5px;' +
      'font-size:10px;line-height:1.6;}' +
      '#vf-prop-editor-hud .pe-bucket.inc{background:#0f2f27;border:1px solid #14532d;color:#86efac;}' +
      '#vf-prop-editor-hud .pe-bucket.full{background:#2f2410;border:1px solid #713f12;color:#fcd34d;}' +
      '#vf-prop-editor-hud .pe-warn{margin:8px 0;padding:6px 8px;border-radius:5px;font-size:10px;' +
      'line-height:1.6;background:#3f1d1d;border:1px solid #7f1d1d;color:#fca5a5;}' +
      '#vf-prop-editor-hud .pe-btn{width:100%;background:#2a313c;border:1px solid #3a424e;color:#d7e2ee;' +
      'border-radius:6px;padding:5px 0;cursor:pointer;font-size:11px;margin:3px 0;}' +
      '#vf-prop-editor-hud .pe-btn:hover{border-color:#3b82f6;}' +
      '#vf-prop-editor-hud .pe-btn.danger{background:#3f1d1d;border-color:#7f1d1d;color:#fca5a5;}' +
      '#vf-prop-editor-hud .pe-btn:disabled{opacity:0.4;cursor:default;}' +
      '#vf-prop-editor-hud .pe-swatch{width:12px;height:12px;border-radius:3px;border:1px solid #0006;' +
      'flex:0 0 auto;}' +
      '#vf-prop-editor-hud.hidden{display:none!important;}' +
      'body.prop-editing #hud{display:none!important;}';
    const style = document.createElement('style');
    style.id = 'vf-prop-editor-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function ensureHud() {
    if (state.hud) return state.hud;
    const hud = document.createElement('div');
    hud.id = 'vf-prop-editor-hud';
    hud.className = 'hidden';
    document.body.appendChild(hud);
    state.hud = hud;
    return hud;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function hex6(id) {
    const colors = global.VF.BLOCK_COLORS || {};
    const v = colors[id];
    return '#' + ('000000' + (v != null ? v : 0x555555).toString(16)).slice(-6);
  }

  /** 滑杆：数值有独立 span，拖动时只改它，不重建面板。 */
  function sliderHtml(id, label, min, max, step, value, suffix) {
    return '<div class="pe-slider">' +
      '<label>' + label + ' <b id="' + id + '-val">' + value + suffix + '</b></label>' +
      '<input type="range" id="' + id + '" min="' + min + '" max="' + max +
      '" step="' + step + '" value="' + value + '"></div>';
  }

  function bucketNoticeHtml(tab) {
    if (tabBucket(tab) === 'inc') {
      return '<div class="pe-bucket inc">增量写入：按住左键连续涂刷，即时生效。</div>';
    }
    return '<div class="pe-bucket full">' +
      '全量重建：每次改动都要重新生成整张地图（会卡一下），不是拖着刷。</div>';
  }

  /* --- 各页正文 ------------------------------------------------------- */

  function propTabHtml(m, size) {
    let html = '<div class="pe-sec">资产库（点击开始放置）</div>';
    if (!m.length) {
      html += '<div class="pe-sub" style="padding:4px 0;">没有烘焙好的 .vox 资产</div>';
    }
    for (let i = 0; i < m.length; i++) {
      const def = propDef(m[i].id);
      const dims = def ? def.w + '×' + def.d + '×' + def.h : '';
      const active = state.placingId === m[i].id && state.tool === 'prop';
      html += '<div class="pe-item' + (active ? ' active' : '') + '" data-pe-lib="' + i + '">' +
        '<span class="pe-name">' + esc(m[i].label || m[i].id) + '</span>' +
        '<span class="pe-sub">' + dims + '</span></div>';
    }
    html += '<div class="pe-sec">已摆 (' + state.props.length + ')</div>';
    if (!state.props.length) {
      html += '<div class="pe-sub" style="padding:4px 0;">暂无摆件</div>';
    }
    for (let i = 0; i < state.props.length; i++) {
      const p = state.props[i];
      const sel = i === state.selectedIndex;
      html += '<div class="pe-item' + (sel ? ' sel' : '') + '" data-pe-row="' + i + '">' +
        '<span class="pe-name">' + esc(p.id) + '</span>' +
        '<span class="pe-sub">' + Math.round(p.nx * size) + ',' + Math.round(p.nz * size) +
        ' ' + (p.yaw || 0) + '°</span>' +
        '<button type="button" class="pe-x" data-pe-del="' + i + '" title="删除">×</button></div>';
    }
    return html;
  }

  function prefabTabHtml(size) {
    let html = '<div class="pe-sec">预制体（点击开始放置）</div>';
    for (let i = 0; i < PREFABS.length; i++) {
      const d = PREFABS[i];
      const active = state.placingKind === d.kind && state.tool === 'prefab';
      html += '<div class="pe-item' + (active ? ' active' : '') + '" data-pe-prefab="' + i + '">' +
        '<span class="pe-name">' + esc(d.label) + '</span>' +
        '<span class="pe-sub">' + d.w + '×' + d.d + '×' + d.h + (d.rotatable ? '' : ' 不可转') +
        '</span></div>';
    }
    html += '<div class="pe-sec">已摆 (' + state.prefabs.length + ')</div>';
    if (!state.prefabs.length) {
      html += '<div class="pe-sub" style="padding:4px 0;">暂无预制体</div>';
    }
    for (let i = 0; i < state.prefabs.length; i++) {
      const p = state.prefabs[i];
      const d = prefabDef(p.kind);
      const sel = i === state.selectedPrefab;
      html += '<div class="pe-item' + (sel ? ' sel' : '') + '" data-pe-pfrow="' + i + '">' +
        '<span class="pe-name">' + esc((d && d.label) || p.kind) + '</span>' +
        '<span class="pe-sub">' + Math.round(p.nx * size) + ',' + Math.round(p.nz * size) +
        ' ' + (p.yaw || 0) + '°</span>' +
        '<button type="button" class="pe-x" data-pe-pfdel="' + i + '" title="删除">×</button></div>';
    }
    html += '<div class="pe-help">高架桥会连带生成桥墩和一条滑索。' +
      '删除后需要重建才会消失（已自动处理）。</div>';
    return html;
  }

  const HEIGHT_MODES = [
    { id: 'raise', label: '抬升' },
    { id: 'lower', label: '降低' },
    { id: 'smooth', label: '抹平' },
    { id: 'flatten', label: '压平到光标高度' },
    { id: 'reset', label: '恢复程序原状' },
  ];

  function heightTabHtml() {
    let html = '<div class="pe-sec">笔刷模式</div>';
    for (let i = 0; i < HEIGHT_MODES.length; i++) {
      const md = HEIGHT_MODES[i];
      const active = state.brush.mode === md.id;
      html += '<div class="pe-item' + (active ? ' active' : '') + '" data-pe-hmode="' + md.id + '">' +
        '<span class="pe-name">' + md.label + '</span></div>';
    }
    html += sliderHtml('pe-radius', '笔刷半径', 2, 60, 1, Math.round(state.brush.radius), ' m');
    html += sliderHtml('pe-strength', '强度', 0.2, 8, 0.1, state.brush.strength, ' m/s');
    html += '<div class="pe-help">' +
      '按住左键涂刷 · 强度是每秒变化量<br>' +
      '「压平」按下瞬间锁定目标高度，拖动不会刷成斜面<br>' +
      '<span class="pe-kbd">Shift+滚轮</span> 调半径 · ' +
      '<span class="pe-kbd">Ctrl+Z</span> 撤销一笔' +
      '</div>';
    return html;
  }

  function materialTabHtml() {
    const pal = materialPalette();
    let html = '<div class="pe-sec">表面材质</div>';
    for (let i = 0; i < pal.length; i++) {
      const it = pal[i];
      if (it.id == null) continue;
      const active = state.paintId === it.id;
      html += '<div class="pe-item' + (active ? ' active' : '') + '" data-pe-mat="' + it.id + '">' +
        (it.id ? '<span class="pe-swatch" style="background:' + hex6(it.id) + '"></span>' : '') +
        '<span class="pe-name">' + esc(it.label) + '</span></div>';
    }
    html += sliderHtml('pe-radius', '笔刷半径', 2, 60, 1, Math.round(state.brush.radius), ' m');
    html += '<div class="pe-help">' +
      '只改地表那一层的材质，不改高度。<br>' +
      '摆件/预制体的地基不会被覆盖。<br>' +
      '<span class="pe-kbd">Shift+滚轮</span> 调半径 · ' +
      '<span class="pe-kbd">Ctrl+Z</span> 撤销一笔' +
      '</div>';
    return html;
  }

  const CONTOUR_MODES = [
    { id: 1, label: '刷成水域' },
    { id: 2, label: '刷成陆地' },
    { id: 0, label: '清除覆盖（还原）' },
  ];

  function waterTabHtml() {
    let html = '<div class="pe-warn">' +
      '⚠ 改水域和地图轮廓会影响旗点、载具出生点、AI 寻路和部署地图。' +
      '大范围改动可能让地图无法正常对战 —— 改完请进对局实际跑一遍。' +
      '</div>';
    html += '<div class="pe-sec">轮廓工具</div>';
    for (let i = 0; i < CONTOUR_MODES.length; i++) {
      const md = CONTOUR_MODES[i];
      const active = state.contourValue === md.id;
      html += '<div class="pe-item' + (active ? ' active' : '') + '" data-pe-contour="' + md.id + '">' +
        '<span class="pe-name">' + md.label + '</span></div>';
    }
    html += sliderHtml('pe-radius', '笔刷半径', 2, 60, 1, Math.round(state.brush.radius), ' m');
    html += '<div class="pe-help">' +
      '点一下刷一片（<b>不是</b>按住拖）—— 轮廓改动要重建整个世界，会卡一下。<br>' +
      '「刷成陆地」还会抹掉盆地外的山脊斜坡，' +
      '这样地形笔刷才能在原本是山的地方造平地。<br>' +
      '<span class="pe-kbd">Shift+滚轮</span> 调半径' +
      '</div>';
    html += '<button type="button" class="pe-btn danger" id="pe-reset-contour">' +
      '清除全部轮廓覆盖</button>';
    return html;
  }

  function syncHud() {
    const hud = ensureHud();
    const m = manifest();
    const size = (world() && world().worldSize) || 1024;
    const hasTerrain = !!draftTerrain();

    let html =
      '<div class="pe-head">' +
      '<div class="pe-title">关卡编辑器</div>' +
      '<div class="pe-mode">' +
      '<button type="button" data-pe-mode="fly"' + (state.mode === 'fly' ? ' class="active"' : '') + '>自由相机</button>' +
      '<button type="button" data-pe-mode="walk"' + (state.mode === 'walk' ? ' class="active"' : '') + '>行走 <span class="pe-kbd">G</span></button>' +
      '</div>' +
      '<div class="pe-speed">速度 <span id="pe-speed">' + Math.round(state.speed) + ' m/s</span> · 滚轮调整</div>' +
      '<div class="pe-tabs">';
    for (let i = 0; i < TABS.length; i++) {
      const t = TABS[i];
      html += '<button type="button" data-pe-tab="' + t.id + '"' +
        (state.tab === t.id ? ' class="active"' : '') + '>' + t.label + '</button>';
    }
    html += '</div>' +
      '<label class="pe-zones"><input type="checkbox" id="pe-zones"' +
      (state.showZones ? ' checked' : '') + '> 显示保护区（出闸/占点）</label>' +
      '</div>';

    html += '<div class="pe-scroll">';
    html += bucketNoticeHtml(state.tab);
    if (state.tab === 'prop') {
      html += propTabHtml(m, size);
    } else if (state.tab === 'prefab') {
      html += prefabTabHtml(size);
    } else if (!hasTerrain) {
      // MapTerrain 没加载 —— 三个地形页全部不可用，说清楚原因而不是给一堆点不动的按钮
      html += '<div class="pe-warn">地形覆盖层没有加载。<br>' +
        '请确认 index.html 里有 js/maps/map-terrain.js 和 ' +
        'js/maps/island-conquest-terrain.js，且都在 island-conquest.js 之前。</div>';
    } else if (state.tab === 'height') {
      html += heightTabHtml();
    } else if (state.tab === 'material') {
      html += materialTabHtml();
    } else if (state.tab === 'water') {
      html += waterTabHtml();
    }

    html += '<div class="pe-help">' +
      'W A S D 移动 · Shift 加速 · Ctrl 减速<br>' +
      '右键拖动 转视角 · 滚轮 调速<br>' +
      'Q 取消 · R 旋转 · Delete 删除 · G 行走<br>' +
      'Ctrl+Z 撤销 · Ctrl+S 保存' +
      '</div>';
    html += '</div>';

    html += '<div class="pe-foot">' +
      '<div class="pe-actions">' +
      '<button type="button" class="pe-save" id="pe-save-btn">' +
      (state.dirty ? '保存到源文件 *' : '保存到源文件') + '</button>' +
      '<button type="button" class="pe-save-as" id="pe-save-as-btn" title="重新选择保存目录">另存为…</button>' +
      '</div>' +
      '<div class="pe-status" id="pe-status"></div></div>';

    hud.innerHTML = html;
    state.statusEl = hud.querySelector('#pe-status');

    /* --- 事件绑定（每次重建都要重新挂）-------------------------------- */

    hud.querySelectorAll('button[data-pe-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        setMode(b.getAttribute('data-pe-mode'));
      });
    });

    hud.querySelectorAll('button[data-pe-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        setTab(b.getAttribute('data-pe-tab'));
      });
    });

    // 摆件
    hud.querySelectorAll('[data-pe-lib]').forEach(function (el) {
      el.addEventListener('click', function () {
        const idx = parseInt(el.getAttribute('data-pe-lib'), 10);
        const id = m[idx].id;
        if (state.tool === 'prop' && state.placingId === id) {
          state.tool = 'none';
          state.placingId = null;
        } else {
          state.tool = 'prop';
          state.placingId = id;
          state.placingKind = null;
          state.yaw = 0;
        }
        rebuildGhost();
        syncHud();
      });
    });
    hud.querySelectorAll('[data-pe-row]').forEach(function (el) {
      el.addEventListener('click', function () {
        const idx = parseInt(el.getAttribute('data-pe-row'), 10);
        state.selectedIndex = idx;
        state.selectedPrefab = -1;
        state.tool = 'none';
        state.placingId = null;
        rebuildGhost();
        flyToProp(idx);
        syncHud();
      });
    });
    hud.querySelectorAll('[data-pe-del]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        const idx = parseInt(el.getAttribute('data-pe-del'), 10);
        state.props.splice(idx, 1);
        if (state.selectedIndex === idx) state.selectedIndex = -1;
        else if (state.selectedIndex > idx) state.selectedIndex--;
        rebuildEditor();
        toast('已删除');
      });
    });

    // 预制体
    hud.querySelectorAll('[data-pe-prefab]').forEach(function (el) {
      el.addEventListener('click', function () {
        const idx = parseInt(el.getAttribute('data-pe-prefab'), 10);
        const kind = PREFABS[idx].kind;
        if (state.tool === 'prefab' && state.placingKind === kind) {
          state.tool = 'none';
          state.placingKind = null;
        } else {
          state.tool = 'prefab';
          state.placingKind = kind;
          state.placingId = null;
          state.yaw = 0;
        }
        rebuildGhost();
        syncHud();
      });
    });
    hud.querySelectorAll('[data-pe-pfrow]').forEach(function (el) {
      el.addEventListener('click', function () {
        const idx = parseInt(el.getAttribute('data-pe-pfrow'), 10);
        state.selectedPrefab = idx;
        state.selectedIndex = -1;
        state.tool = 'none';
        state.placingKind = null;
        rebuildGhost();
        flyToPrefab(idx);
        syncHud();
      });
    });
    hud.querySelectorAll('[data-pe-pfdel]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        const idx = parseInt(el.getAttribute('data-pe-pfdel'), 10);
        state.prefabs.splice(idx, 1);
        if (state.selectedPrefab === idx) state.selectedPrefab = -1;
        else if (state.selectedPrefab > idx) state.selectedPrefab--;
        rebuildEditor();
        toast('已删除');
      });
    });

    // 地形笔刷模式
    hud.querySelectorAll('[data-pe-hmode]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.brush.mode = el.getAttribute('data-pe-hmode');
        state.tool = 'height';
        syncHud();
      });
    });

    // 材质
    hud.querySelectorAll('[data-pe-mat]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.paintId = parseInt(el.getAttribute('data-pe-mat'), 10) || 0;
        state.tool = 'material';
        syncHud();
      });
    });

    // 水域轮廓
    hud.querySelectorAll('[data-pe-contour]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.contourValue = parseInt(el.getAttribute('data-pe-contour'), 10) || 0;
        state.tool = 'water';
        syncHud();
      });
    });
    const resetContour = hud.querySelector('#pe-reset-contour');
    if (resetContour) {
      resetContour.addEventListener('click', function () {
        const MT = mapTerrain();
        const data = draftTerrain();
        if (!MT || !data) return;
        MT.fillRect(data, 'water', 0, 0, data.cells - 1, data.cells - 1, 0);
        rebuildEditor();
        toast('已清除全部轮廓覆盖');
      });
    }

    // 滑杆：只改自己的读数，绝不调 syncHud（会打断拖动）
    const radius = hud.querySelector('#pe-radius');
    if (radius) {
      radius.addEventListener('input', function () {
        state.brush.radius = parseFloat(radius.value) || 1;
        const out = hud.querySelector('#pe-radius-val');
        if (out) out.textContent = Math.round(state.brush.radius) + ' m';
      });
    }
    const strength = hud.querySelector('#pe-strength');
    if (strength) {
      strength.addEventListener('input', function () {
        state.brush.strength = parseFloat(strength.value) || 0.2;
        const out = hud.querySelector('#pe-strength-val');
        if (out) out.textContent = state.brush.strength + ' m/s';
      });
    }

    const saveBtn = hud.querySelector('#pe-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', function () { exportToFile(); });
    const saveAsBtn = hud.querySelector('#pe-save-as-btn');
    if (saveAsBtn) saveAsBtn.addEventListener('click', function () { exportToFile(true); });
    const zoneBox = hud.querySelector('#pe-zones');
    if (zoneBox) {
      zoneBox.addEventListener('change', function () {
        state.showZones = !!zoneBox.checked;
        rebuildZones();
      });
    }

    // 面板上任何指针事件都不要穿透到场景
    hud.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    return hud;
  }

  /**
   * 切页。切页会取消当前正在进行的放置/涂刷 —— 带着摆件 ghost 跳到地形页
   * 只会让人困惑。选中态保留，方便切页后继续删。
   */
  function setTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    state.placingId = null;
    state.placingKind = null;
    state.brush.painting = false;
    state.brush.flattenTo = null;
    // 笔刷页默认就带上工具（不用再点一次模式），放置页要显式点资产。
    state.tool = tabBucket(tab) === 'inc' ? tab : (tab === 'water' ? 'water' : 'none');
    if (!draftTerrain() && (tab === 'height' || tab === 'material' || tab === 'water')) {
      state.tool = 'none';
    }
    rebuildGhost();
    updateBrushRing();
    syncHud();
  }

  function flyToPrefab(index) {
    const p = state.prefabs[index];
    const w = world();
    if (!p || !w) return;
    if (state.mode !== 'fly') setMode('fly');
    const d = prefabDef(p.kind) || { w: 16, d: 16, h: 16 };
    const cx = p.nx * w.worldSize;
    const cz = p.nz * w.worldSize;
    const gy = w._surface ? w._surface(Math.floor(cx), Math.floor(cz)) : 4;
    startFlyTo(cx + d.w * 0.8, gy + 1 + d.h * 1.4, cz + d.d * 0.8, cx, gy + 1 + d.h * 0.5, cz);
  }

  /* ------------------------------------------------------------------ *
   * 进入 / 退出
   * ------------------------------------------------------------------ */
  function enter() {
    const g = game();
    const w = world();
    if (!g || !w || !w.regenerate) return;
    injectStyles();
    bindInput();

    const draft = readLayout();
    const saved = savedLayout().map(function (p) {
      return { id: p.id, nx: p.nx, nz: p.nz, yaw: p.yaw || 0 };
    });
    const savedPf = savedPrefabs().map(function (p) {
      return { kind: p.kind, nx: p.nx, nz: p.nz, yaw: p.yaw || 0 };
    });
    // 草稿只是面板数据；world 是按源文件生成的。两者不一致就必须把草稿盖进
    // 体素世界，否则面板里的摆件在场景里不存在（选中只剩一个空框）。
    let restoredDraft = false;
    if (draft && (!sameLayout(draft.props, saved) || !sameLayout(draft.prefabs, savedPf))) {
      state.props = draft.props.map(function (p) {
        return { id: p.id, nx: p.nx, nz: p.nz, yaw: p.yaw || 0 };
      });
      state.prefabs = draft.prefabs.map(function (p) {
        return { kind: p.kind, nx: p.nx, nz: p.nz, yaw: p.yaw || 0 };
      });
      restoredDraft = true;
    } else {
      state.props = saved;
      state.prefabs = savedPf;
    }
    state.dirty = false;
    state.yaw = 0;
    state.tab = 'prop';
    state.tool = 'none';
    state.placingId = null;
    state.placingKind = null;
    state.selectedIndex = -1;
    state.selectedPrefab = -1;
    state.undo.length = 0;
    state.brush.painting = false;
    state.brush.flattenTo = null;
    state._lodFocusX = null;
    state._lodFocusZ = null;
    state._wasRunning = !!g.running;

    if (global.VF.Lobby && global.VF.Lobby.hide) global.VF.Lobby.hide();
    if (global.VF.Hub && global.VF.Hub.hide) global.VF.Hub.hide();
    const cover = document.getElementById('start-overlay');
    if (cover) cover.classList.add('hidden');

    document.exitPointerLock && document.exitPointerLock();
    initCam();
    state.mode = 'fly';
    g.running = false;
    g.levelEditing = true;
    document.body.classList.add('prop-editing');

    if (g.player && g.player.setHeldMode) g.player.setHeldMode('build');
    if (g.weapons) {
      if (g.weapons._cancelReload) g.weapons._cancelReload();
      g.weapons.mode = 'build';
      g.weapons.firing = false;
    }
    if (g.building && g.building.exitMode) g.building.exitMode();

    state.active = true;
    setAvatarVisible(false);
    if (restoredDraft) {
      // 把草稿真的盖进世界，面板和场景才对得上。
      regenerateWith(state.props.slice(), state.prefabs.slice());
      state.dirty = true;
      streamAround(state.cam.x, state.cam.z);
    }
    rebuildGhost();
    rebuildSelBox();
    rebuildZones();
    syncHud();
    ensureHud().classList.remove('hidden');
    if (restoredDraft) {
      setStatus('已恢复未保存草稿（摆件 ' + state.props.length +
        ' · 预制体 ' + state.prefabs.length + '）· Ctrl+S 写入源文件');
    } else if (!draftTerrain()) {
      setStatus('⚠ 地形覆盖层未加载，地形/材质/水域页不可用（详见对应页说明）');
    } else {
      setStatus('自由相机：右键拖动转视角 · WASD 移动 · 滚轮调速 · 上方切换工具页');
    }
  }

  function exit() {
    const g = game();
    state.active = false;
    disposeMesh(state.ghost);
    state.ghost = null;
    disposeMesh(state.selBox);
    state.selBox = null;
    if (state.zones) {
      for (let i = 0; i < state.zones.length; i++) disposeMesh(state.zones[i]);
      state.zones = null;
    }
    disposeMesh(state.brush.ring);
    state.brush.ring = null;
    state.brush.ringKey = '';
    state.brush.painting = false;
    document.body.classList.remove('prop-editing');
    if (state.hud) state.hud.classList.add('hidden');
    if (g) {
      g.levelEditing = false;
      g.running = state._wasRunning;
      if (g.player && g.player.setHeldMode) g.player.setHeldMode('weapon');
      if (g.weapons) g.weapons.mode = 'weapon';
      setAvatarVisible(true);
    }
    document.exitPointerLock && document.exitPointerLock();
    if (state.dirty) {
      // 世界回滚到源文件状态（不然未保存的改动会影响正常对局）。摆件/预制体的
      // 草稿留在 localStorage 里，下次进编辑器会连同世界一起恢复；**地形不进
      // 草稿**，所以这里的地形改动就此丢弃 —— 下面的提示要说清楚。
      const MT = mapTerrain();
      const hadTerrain = !!(MT && draftTerrain() && !MT.isBlank(draftTerrain()));
      rebuildSaved();
      state.undo.length = 0;
      if (hadTerrain) {
        toast('地形改动已丢弃（地形不存草稿）；摆件/预制体存为草稿。Ctrl+S 才会写入源文件');
      } else {
        toast('改动已存为草稿，未写入源文件（Ctrl+S 保存）');
      }
    }
  }

  function toggle() {
    if (state.active) exit();
    else enter();
  }

  /* ------------------------------------------------------------------ *
   * 输入
   * ------------------------------------------------------------------ */
  function bindInput() {
    if (state._bound) return;
    state._bound = true;

    document.addEventListener('keydown', function (e) {
      state.keys[e.code] = true;
      if (!state.active) return;
      if (e.target && e.target.closest && e.target.closest('#vf-prop-editor-hud')) return;
      if (e.code === 'KeyG') {
        e.preventDefault();
        setMode(state.mode === 'fly' ? 'walk' : 'fly');
        return;
      }
      if (e.code === 'KeyQ') {
        cancelCurrent();
        return;
      }
      if (e.code === 'KeyR') {
        rotateBy(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        exportToFile();
        return;
      }
      if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        undoStroke();
        return;
      }
      if (e.code === 'Escape') {
        if (state.tool !== 'none' || state.selectedIndex >= 0 || state.selectedPrefab >= 0) {
          cancelCurrent();
        } else {
          exit();
        }
        return;
      }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        deleteSelected();
      }
    });

    document.addEventListener('keyup', function (e) {
      state.keys[e.code] = false;
    });

    // alt-tab 切走时 keyup / mouseup 都收不到：不清的话相机会自己一直飘，
    // 笔刷会在切回来之前一直刷（update 里按帧推进）。
    window.addEventListener('blur', function () {
      state.keys = {};
      if (state.brush.painting) {
        state.brush.painting = false;
        state.brush.flattenTo = null;
        endStroke();
      }
    });

    document.addEventListener('mousemove', function (e) {
      state.mouse.x = e.clientX;
      state.mouse.y = e.clientY;
      if (!state.active) return;
      if (document.pointerLockElement) {
        if (state.mode === 'fly') {
          state.cam.yaw -= e.movementX * 0.0022;
          state.cam.pitch = Math.max(-1.55, Math.min(1.55, state.cam.pitch - e.movementY * 0.0022));
          state.anim = null;
        }
      }
    });

    document.addEventListener('mousedown', function (e) {
      if (!state.active) return;
      if (e.target && e.target.closest && e.target.closest('#vf-prop-editor-hud')) return;
      if (e.button === 2) {
        e.preventDefault();
        if (state.mode === 'fly') {
          state.lookLocked = true;
          const g = game();
          const canvas = g && g.renderer && g.renderer.domElement;
          if (canvas && canvas.requestPointerLock) {
            try { canvas.requestPointerLock(); } catch (_) {}
          }
        }
        return;
      }
      if (e.button === 0) {
        if (state.tool === 'prop' || state.tool === 'prefab') {
          placeAt();
        } else if (state.tool === 'height' || state.tool === 'material') {
          // 按下开始一笔，实际涂刷在 update() 里按帧推进（强度是 m/s）。
          beginStroke(state.tool === 'height' ? 'h' : 'mat');
          state.brush.painting = true;
          if (state.brush.mode === 'flatten') {
            const pos = groundPoint();
            const w = world();
            // 压平的目标高度在按下这一刻锁定；拖动时跟着光标变会刷成斜面。
            state.brush.flattenTo =
              pos && w && w.getTerrainTop ? w.getTerrainTop(pos.x, pos.z) : null;
          }
        } else if (state.tool === 'water') {
          const pos = groundPoint();
          if (pos) {
            const n = applyContourBrush(pos.x, pos.z, state.contourValue);
            setStatus(n ? '轮廓已更新（' + n + ' 个控制点）' : '这一片轮廓没有变化');
          }
        } else {
          selectAt();
        }
      }
    });

    document.addEventListener('mouseup', function (e) {
      if (!state.active) return;
      if (e.button === 2 && state.mode === 'fly') {
        state.lookLocked = false;
        document.exitPointerLock && document.exitPointerLock();
      }
      if (e.button === 0 && state.brush.painting) {
        state.brush.painting = false;
        state.brush.flattenTo = null;
        endStroke();
        syncHud();
      }
    });

    document.addEventListener('contextmenu', function (e) {
      if (state.active) e.preventDefault();
    });

    document.addEventListener('wheel', function (e) {
      if (!state.active || state.mode !== 'fly') return;
      if (e.target && e.target.closest && e.target.closest('#vf-prop-editor-hud')) return;
      e.preventDefault();
      // 笔刷页：Shift+滚轮调半径（比来回拖滑杆快得多）。
      const brushing = state.tool === 'height' || state.tool === 'material' || state.tool === 'water';
      if (brushing && e.shiftKey) {
        state.brush.radius *= e.deltaY > 0 ? (1 / 1.15) : 1.15;
        state.brush.radius = Math.max(2, Math.min(60, state.brush.radius));
        const rv = document.getElementById('pe-radius-val');
        if (rv) rv.textContent = Math.round(state.brush.radius) + ' m';
        const rs = document.getElementById('pe-radius');
        if (rs) rs.value = String(Math.round(state.brush.radius));
        return;
      }
      state.speed *= e.deltaY > 0 ? (1 / 1.15) : 1.15;
      state.speed = Math.max(2, Math.min(400, state.speed));
      const el = document.getElementById('pe-speed');
      if (el) el.textContent = Math.round(state.speed) + ' m/s';
    }, { passive: false });
  }

  /* ------------------------------------------------------------------ *
   * 主循环钩子（由 main.js 每帧调用）
   * ------------------------------------------------------------------ */
  function update(dt) {
    if (!state.active) return;
    if (state.mode === 'fly') {
      setAvatarVisible(false);
      if (state.anim) tickAnim();
      else moveFlyCam(dt);
      streamAround(state.cam.x, state.cam.z);
    } else {
      const g = game();
      if (g && g.player && g.player.object) {
        const p = g.player.object.position;
        streamAround(p.x, p.z);
      }
    }
    tickBrush(dt);
    updateGhost();
    updateSelectionBox();
    updateBrushRing();
  }

  /**
   * 按帧推进笔刷。强度按 m/s 计，所以帧率不影响涂刷速度。
   *
   * dt 上限 0.05s：切标签页回来时 main.js 可能给一个很大的 dt，不封顶会一帧刷出
   * 一个几十米的坑。
   */
  function tickBrush(dt) {
    if (!state.brush.painting) return;
    if (state.tool !== 'height' && state.tool !== 'material') return;
    const pos = groundPoint();
    if (!pos) return;
    const step = Math.min(0.05, Math.max(0, dt || 0));
    if (state.tool === 'height') {
      if (step > 0) applyHeightBrush(pos.x, pos.z, step);
    } else {
      applyMaterialBrush(pos.x, pos.z, state.paintId);
    }
  }

  /* ------------------------------------------------------------------ *
   * 挂载：F8 热键 + 开发工具栏按钮
   * ------------------------------------------------------------------ */
  function ensureToolbar() {
    if (global.VF.DevTools && global.VF.DevTools.ensureToolbar) {
      return global.VF.DevTools.ensureToolbar();
    }
    let bar = document.getElementById('vf-dev-toolbar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'vf-dev-toolbar';
    bar.className = 'vf-dev-toolbar';
    document.body.appendChild(bar);
    return bar;
  }

  function mount() {
    injectStyles();
    document.addEventListener('keydown', function (e) {
      if (e.code !== 'F8') return;
      if (e.target && e.target.closest && e.target.closest('#vf-prop-editor-hud')) return;
      e.preventDefault();
      toggle();
    });
    const bar = ensureToolbar();
    let btn = document.getElementById('vf-dev-btn-prop');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'vf-dev-btn-prop';
      btn.type = 'button';
      btn.textContent = '关卡 F8';
      bar.appendChild(btn);
    }
    btn.addEventListener('click', function () {
      toggle();
      btn.classList.toggle('active', state.active);
    });
  }

  global.VF.LevelEditor = {
    toggle: toggle,
    enter: enter,
    exit: exit,
    update: update,
    applyCamera: applyCamera,
    isActive: function () { return state.active; },
    isFreeCam: function () { return state.active && state.mode === 'fly'; },
    getProps: function () { return state.props.slice(); },
    getPrefabs: function () { return state.prefabs.slice(); },
    canUndo: canUndo,
  };
  // 旧名保留为别名：万一还有没改到的引用，静默失效比报错更难查。
  global.VF.PropEditor = global.VF.LevelEditor;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
