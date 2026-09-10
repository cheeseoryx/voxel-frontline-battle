/**
 * map-editor.js — 大厅「地图」
 * - 俯视格子搭建：左键放置/画桥，右键删除，Q/R 旋转
 * - 局内第一人称编辑：同一套 kit，WASD 在战场里摆
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};
  if (global.VF._mapEditorMounted) return;
  global.VF._mapEditorMounted = true;

  const GRID = 8;
  const HEIGHTS = [
    { id: 'low', label: '低', deckY: 18, color: 'rgba(74, 85, 96, 0.75)' },
    { id: 'mid', label: '中', deckY: 28, color: 'rgba(90, 130, 170, 0.75)' },
    { id: 'high', label: '高', deckY: 40, color: 'rgba(160, 180, 200, 0.78)' },
  ];

  const PREFABS = [
    { id: 'house', label: '小屋', w: 14, d: 12, color: '#d8d2c4', rotatable: true },
    { id: 'midrise', label: '中楼', w: 13, d: 13, color: '#9a968e', rotatable: true },
    { id: 'skyscraper', label: '摩天楼', w: 16, d: 16, color: '#6e7278', rotatable: true },
    { id: 'ruin', label: '废墟', w: 10, d: 10, color: '#5a5048', rotatable: true },
    { id: 'factory', label: '工厂', w: 40, d: 28, color: '#8b4518', rotatable: true },
    { id: 'bridge', label: '桥梁（拖画）', w: GRID, d: GRID, color: '#4a5560', rotatable: true, paint: true },
    { id: 'zipline', label: '滑索', w: GRID, d: GRID, color: '#9ab8d0', rotatable: false, zipline: true },
    { id: 'spawnAlly', label: '蓝方出生水晶', w: GRID, d: GRID, color: '#33aaff', rotatable: false, spawn: 'ally' },
    { id: 'spawnEnemy', label: '红方出生水晶', w: GRID, d: GRID, color: '#ff3344', rotatable: false, spawn: 'enemy' },
    { id: 'aiSpawnAlly', label: '蓝方AI刷新点', w: GRID, d: GRID, color: '#44d0c8', rotatable: false, aiSpawn: 'ally' },
    { id: 'aiSpawnEnemy', label: '红方AI刷新点', w: GRID, d: GRID, color: '#ff8844', rotatable: false, aiSpawn: 'enemy' },
  ];

  const KIT_STORAGE_KEY = 'vf_small_map_kit_v2';

  const state = {
    open: false,
    fpsMode: false,
    prefab: 'house',
    bridgeHeight: 'low',
    yaw: 0,
    placed: [],
    hover: null,
    hoverGx: -1,
    hoverGz: -1,
    hoverIndex: -1,
    canvas: null,
    countEl: null,
    yawEl: null,
    raf: 0,
    needsRedraw: true,
    painting: false,
    paintErase: false,
    lastPaintKey: '',
    _wasRunning: false,
    _fpsHud: null,
    _fpsBound: false,
    fromLobby: false,
    terrain: null,
    genPreview: null,
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function game() {
    return global.VF && global.VF.game;
  }

  function world() {
    const g = game();
    return g && g.world;
  }

  function prefabDef(id) {
    for (let i = 0; i < PREFABS.length; i++) {
      if (PREFABS[i].id === id) return PREFABS[i];
    }
    return PREFABS[0];
  }

  function heightDef(id) {
    for (let i = 0; i < HEIGHTS.length; i++) {
      if (HEIGHTS[i].id === id) return HEIGHTS[i];
    }
    return HEIGHTS[0];
  }

  function isBridgeTool() {
    return state.prefab === 'bridge';
  }

  function isZiplineTool() {
    return state.prefab === 'zipline';
  }

  function isSpawnTool() {
    const d = prefabDef(state.prefab);
    return !!(d && d.spawn);
  }

  function isAiSpawnTool() {
    const d = prefabDef(state.prefab);
    return !!(d && d.aiSpawn);
  }

  function worldToGrid(wx, wz) {
    return { gx: Math.floor(wx / GRID), gz: Math.floor(wz / GRID) };
  }

  function gridCenter(gx, gz) {
    return { x: gx * GRID + GRID * 0.5, z: gz * GRID + GRID * 0.5 };
  }

  function snapWorld(wx, wz) {
    const g = worldToGrid(wx, wz);
    const c = gridCenter(g.gx, g.gz);
    return { gx: g.gx, gz: g.gz, x: c.x, z: c.z };
  }

  function footprintFor(def, yaw) {
    let w = def.w;
    let d = def.d;
    if (def.rotatable && (yaw === 90 || yaw === 270)) {
      w = def.d;
      d = def.w;
    }
    return { w: w, d: d };
  }

  function readStoredKit() {
    try {
      let raw = localStorage.getItem(KIT_STORAGE_KEY);
      if (!raw) raw = localStorage.getItem('vf_small_map_kit_v1');
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.active) return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  function serializePlaced(p) {
    const out = {
      kind: p.kind,
      cx: p.cx,
      cz: p.cz,
      yaw: p.yaw || 0,
      ox: p.ox,
      oz: p.oz,
      w: p.w,
      d: p.d,
    };
    if (p.kind === 'bridgeNet' && p.cells) {
      out.cells = p.cells.map(function (c) {
        return { gx: c.gx, gz: c.gz };
      });
      out.cellSize = p.cellSize || GRID;
      out.height = p.height || 'low';
      out.deckY = p.deckY;
    }
    if (p.kind === 'zipline') {
      out.bridgeGx = p.bridgeGx;
      out.bridgeGz = p.bridgeGz;
      out.height = p.height || 'low';
      out.gx = p.gx;
      out.gz = p.gz;
    }
    if (p.kind === 'spawn') {
      out.team = p.team === 'enemy' ? 'enemy' : 'ally';
    }
    if (p.kind === 'aiSpawn') {
      out.team = p.team === 'enemy' ? 'enemy' : 'ally';
    }
    return out;
  }

  function writeStoredKit(active) {
    const g = game();
    const payload = {
      active: !!active,
      seed: g && g.mapSeed != null ? g.mapSeed >>> 0 : 0,
      grid: GRID,
      placed: state.placed.map(serializePlaced),
    };
    if (state.terrain && state.terrain.data) {
      payload.terrain = {
        cells: state.terrain.cells || 40,
        data: Array.prototype.slice.call(state.terrain.data),
      };
    }
    try {
      localStorage.setItem(KIT_STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
    if (g) {
      g._mapKitLayout = !!active;
      g._mapKitPlaced = payload.placed.slice();
      g._mapKitTerrain = payload.terrain || null;
      if (active) {
        if (g.mapSeed == null) g.mapSeed = payload.seed;
        g._mapReadyForSeed = g.mapSeed >>> 0;
      }
    }
    return payload;
  }

  function stampOne(w, item) {
    if (!item || !item.kind) return null;
    if (item.kind === 'bridgeNet' || (item.kind === 'bridge' && item.cells)) {
      return w.stampBridgeNetwork(
        item.cells || [],
        item.cellSize || GRID,
        item.yaw || 0,
        item.height || item.deckY || 'low'
      );
    }
    if (item.kind === 'zipline') {
      return w.stampKitZipline({
        bridgeGx: item.bridgeGx,
        bridgeGz: item.bridgeGz,
        height: item.height || 'low',
        gx: item.gx,
        gz: item.gz,
        cellSize: GRID,
      });
    }
    if (item.kind === 'spawn') {
      return {
        kind: 'spawn',
        team: item.team === 'enemy' ? 'enemy' : 'ally',
        cx: item.cx,
        cz: item.cz,
        x: item.cx,
        z: item.cz,
        w: GRID,
        d: GRID,
        ox: Math.floor(item.cx - GRID * 0.5),
        oz: Math.floor(item.cz - GRID * 0.5),
        yaw: 0,
      };
    }
    if (item.kind === 'aiSpawn' || item.kind === 'aiSpawnAlly' || item.kind === 'aiSpawnEnemy') {
      const team =
        item.team === 'enemy' || item.kind === 'aiSpawnEnemy' ? 'enemy' : 'ally';
      return {
        kind: 'aiSpawn',
        team: team,
        cx: item.cx,
        cz: item.cz,
        x: item.cx,
        z: item.cz,
        w: GRID,
        d: GRID,
        ox: Math.floor(item.cx - GRID * 0.5),
        oz: Math.floor(item.cz - GRID * 0.5),
        yaw: 0,
      };
    }
    return w.stampEditorPrefab(item.kind, item.cx, item.cz, item.yaw || 0);
  }

  const BUILDING_KINDS = {
    house: 1,
    midrise: 1,
    skyscraper: 1,
    ruin: 1,
    factory: 1,
  };

  /** Drop buildings/cover on water and bridge cells that don't touch land. */
  function filterPlacedAgainstTerrain(placedList, terrain) {
    if (!terrain || !terrain.data) return placedList || [];
    const cells = terrain.cells || 40;
    const data = terrain.data;
    const clsAt = function (gx, gz) {
      if (gx < 0 || gz < 0 || gx >= cells || gz >= cells) return -1;
      return data[gz * cells + gx] | 0;
    };
    const isWater = function (gx, gz) {
      return clsAt(gx, gz) === SEM.WATER;
    };
    const worldToCell = function (wx, wz) {
      return {
        gx: Math.floor(wx / GRID),
        gz: Math.floor(wz / GRID),
      };
    };
    const out = [];
    for (let i = 0; i < placedList.length; i++) {
      const p = placedList[i];
      if (!p || !p.kind) continue;
      if (BUILDING_KINDS[p.kind]) {
        const c = worldToCell(p.cx, p.cz);
        if (isWater(c.gx, c.gz)) continue;
        if (isWater(c.gx + 1, c.gz) || isWater(c.gx - 1, c.gz) || isWater(c.gx, c.gz + 1) || isWater(c.gx, c.gz - 1)) {
          // allow 1-neighbor water (coast) but reject if center-adjacent majority water
          let wn = 0;
          if (isWater(c.gx + 1, c.gz)) wn++;
          if (isWater(c.gx - 1, c.gz)) wn++;
          if (isWater(c.gx, c.gz + 1)) wn++;
          if (isWater(c.gx, c.gz - 1)) wn++;
          if (wn >= 2) continue;
        }
        out.push(p);
        continue;
      }
      if (p.kind === 'bridgeNet' || (p.kind === 'bridge' && p.cells)) {
        const cellsIn = p.cells || [];
        const LAND_REACH = 8; // match kit MAX_SPAN so mid-span water cells survive
        const kept = [];
        for (let j = 0; j < cellsIn.length; j++) {
          const gx = cellsIn[j].gx;
          const gz = cellsIn[j].gz;
          if (!isWater(gx, gz)) {
            kept.push(cellsIn[j]);
            continue;
          }
          let land = false;
          for (let d = 1; d <= LAND_REACH && !land; d++) {
            if (!isWater(gx - d, gz) && clsAt(gx - d, gz) >= 0 && clsAt(gx - d, gz) !== SEM.WATER) land = true;
            if (!isWater(gx + d, gz) && clsAt(gx + d, gz) >= 0 && clsAt(gx + d, gz) !== SEM.WATER) land = true;
            if (!isWater(gx, gz - d) && clsAt(gx, gz - d) >= 0 && clsAt(gx, gz - d) !== SEM.WATER) land = true;
            if (!isWater(gx, gz + d) && clsAt(gx, gz + d) >= 0 && clsAt(gx, gz + d) !== SEM.WATER) land = true;
          }
          if (land) kept.push(cellsIn[j]);
        }
        // Keep cells that connect to an already-kept neighbor (fill mid gaps)
        let grew = true;
        while (grew) {
          grew = false;
          const key = {};
          for (let k = 0; k < kept.length; k++) key[kept[k].gx + ',' + kept[k].gz] = true;
          for (let j = 0; j < cellsIn.length; j++) {
            const gx = cellsIn[j].gx;
            const gz = cellsIn[j].gz;
            const kk = gx + ',' + gz;
            if (key[kk]) continue;
            if (
              key[gx + 1 + ',' + gz] ||
              key[gx - 1 + ',' + gz] ||
              key[gx + ',' + (gz + 1)] ||
              key[gx + ',' + (gz - 1)]
            ) {
              kept.push(cellsIn[j]);
              grew = true;
            }
          }
        }
        if (kept.length) {
          out.push(Object.assign({}, p, { cells: kept }));
        }
        continue;
      }
      if (p.kind === 'zipline') {
        if (p.bridgeGx != null && isWater(p.bridgeGx, p.bridgeGz)) {
          let land = false;
          for (let d = 1; d <= 8; d++) {
            if (!isWater(p.bridgeGx - d, p.bridgeGz)) land = true;
            if (!isWater(p.bridgeGx + d, p.bridgeGz)) land = true;
          }
          if (!land) continue;
        }
        out.push(p);
        continue;
      }
      if (p.kind === 'spawn' || p.kind === 'spawnAlly' || p.kind === 'spawnEnemy') {
        const c = worldToCell(p.cx, p.cz);
        if (isWater(c.gx, c.gz)) continue;
        out.push(p);
        continue;
      }
      if (p.kind === 'aiSpawn' || p.kind === 'aiSpawnAlly' || p.kind === 'aiSpawnEnemy') {
        const c = worldToCell(p.cx, p.cz);
        if (isWater(c.gx, c.gz)) continue;
        out.push({
          kind: 'aiSpawn',
          team: p.team === 'enemy' || p.kind === 'aiSpawnEnemy' ? 'enemy' : 'ally',
          cx: p.cx,
          cz: p.cz,
          yaw: 0,
        });
        continue;
      }
      out.push(p);
    }
    return out;
  }

  /** Group bridge cells by height; stamp each layer separately so they can overlap. */
  function applyKitToWorld(placedList, opts) {
    opts = opts || {};
    const g = game();
    const w = world();
    if (!g || !w || !w.prepareEditorCanvas) return false;

    try {
      const terrain =
        opts.terrain !== undefined ? opts.terrain : state.terrain;
      if (opts.terrain !== undefined) state.terrain = opts.terrain;
      const list = filterPlacedAgainstTerrain(placedList || [], terrain);
      w.prepareEditorCanvas(terrain ? { terrain: terrain } : {});
      if (g.bases && g.bases.rebuildAfterMapGen) g.bases.rebuildAfterMapGen();

      if (g.ai && g.ai._clearUnits) {
        g.ai._clearUnits();
        g.ai._armiesSpawned = false;
      }
      if (g.resources && g.resources.length) {
        for (let i = 0; i < g.resources.length; i++) {
          const r = g.resources[i];
          if (r.mesh && r.mesh.parent) r.mesh.parent.remove(r.mesh);
        }
        g.resources.length = 0;
      }

      // Defer chunk remesh: each stamp dirtyRect's; rebuild once at the end
      const prevFlush = w.flushRebuilds;
      w.flushRebuilds = function () {};

      const stamped = [];
      const bridgesByHeight = { low: [], mid: [], high: [] };
      const bridgeYawByH = { low: 0, mid: 0, high: 0 };
      const ziplines = [];
      const spawns = [];
      const aiSpawns = [];

      try {
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          if (!p || !p.kind) continue;
          if (p.kind === 'bridgeNet' || (p.kind === 'bridge' && p.cells)) {
            const h = p.height === 'mid' || p.height === 'high' ? p.height : 'low';
            bridgeYawByH[h] = p.yaw || bridgeYawByH[h] || 0;
            const cells = p.cells || [];
            for (let j = 0; j < cells.length; j++) bridgesByHeight[h].push(cells[j]);
            continue;
          }
          if (p.kind === 'zipline') {
            ziplines.push(p);
            continue;
          }
          if (p.kind === 'spawn' || p.kind === 'spawnAlly' || p.kind === 'spawnEnemy') {
            spawns.push({
              kind: 'spawn',
              team: p.team || (p.kind === 'spawnEnemy' ? 'enemy' : 'ally'),
              cx: p.cx,
              cz: p.cz,
            });
            continue;
          }
          if (p.kind === 'aiSpawn' || p.kind === 'aiSpawnAlly' || p.kind === 'aiSpawnEnemy') {
            aiSpawns.push({
              kind: 'aiSpawn',
              team: p.team || (p.kind === 'aiSpawnEnemy' ? 'enemy' : 'ally'),
              cx: p.cx,
              cz: p.cz,
            });
            continue;
          }
          const s = stampOne(w, p);
          if (s) stamped.push(s);
        }

        ['low', 'mid', 'high'].forEach(function (h) {
          const cells = bridgesByHeight[h];
          if (!cells.length || !w.stampBridgeNetwork) return;
          const net = w.stampBridgeNetwork(cells, GRID, bridgeYawByH[h], h);
          if (net) stamped.push(net);
        });

        for (let i = 0; i < ziplines.length; i++) {
          const z = stampOne(w, ziplines[i]);
          if (z) stamped.push(z);
        }

        for (let i = 0; i < spawns.length; i++) {
          const sp = stampOne(w, spawns[i]);
          if (sp) stamped.push(sp);
        }
        for (let i = 0; i < aiSpawns.length; i++) {
          const ap = stampOne(w, aiSpawns[i]);
          if (ap) stamped.push(ap);
        }
      } finally {
        w.flushRebuilds = prevFlush;
      }

      if (g.bases && g.bases.applyKitSpawns) {
        g.bases.applyKitSpawns(spawns);
      }

      const aiAlly = [];
      const aiEnemy = [];
      for (let i = 0; i < aiSpawns.length; i++) {
        const a = aiSpawns[i];
        const entry = { x: a.cx, z: a.cz, cx: a.cx, cz: a.cz };
        if (a.team === 'enemy') aiEnemy.push(entry);
        else aiAlly.push(entry);
      }
      w._aiSpawns = { ally: aiAlly, enemy: aiEnemy };
      g._mapKitAiSpawns = { ally: aiAlly.slice(), enemy: aiEnemy.slice() };

      if (w._rebuildAllChunks) {
        w._rebuildAllChunks({ progressive: false });
      } else {
        if (w.ensureMeshedAround && g.bases && g.bases.allyOrigin) {
          w.ensureMeshedAround(g.bases.allyOrigin.x, g.bases.allyOrigin.z, 10);
        }
        if (w.ensureMeshedAround && g.bases && g.bases.enemyOrigin) {
          w.ensureMeshedAround(g.bases.enemyOrigin.x, g.bases.enemyOrigin.z, 10);
        }
        if (w.flushRebuilds) w.flushRebuilds(256);
      }

      state.placed = stamped;
      g._mapKitLayout = true;
      w._editorCanvas = true;
      if (g.mapSeed == null) g.mapSeed = w.mapSeed >>> 0;
      g._mapReadyForSeed = g.mapSeed >>> 0;
      g._mapKitPlaced = stamped.map(serializePlaced);
      g._mapKitTerrain = state.terrain || null;
      if (!opts.skipSave) writeStoredKit(true);
      if (global.VF.UI && global.VF.UI.invalidateWorldMapCache) {
        global.VF.UI.invalidateWorldMapCache();
      }
      return true;
    } catch (err) {
      console.error('[VF] applyKitToWorld', err);
      return false;
    }
  }

  function disableKitLayout() {
    const g = game();
    state.placed = [];
    state.terrain = null;
    state.genPreview = null;
    try {
      localStorage.removeItem(KIT_STORAGE_KEY);
      localStorage.removeItem('vf_small_map_kit_v1');
    } catch (_) {}
    if (g) {
      g._mapKitPlaced = [];
      g._mapKitTerrain = null;
      g._mapKitAiSpawns = null;
      g._mapReadyForSeed = null;
    }
    applyKitToWorld([], { skipSave: true, terrain: null });
    if (g) g._mapKitLayout = true;
  }

  function getDefaultKitPlaced() {
    const kit = global.VF && global.VF.DEFAULT_MAP_KIT;
    if (kit && kit.placed && kit.placed.length) return kit.placed.slice();
    return null;
  }

  function resolvePlacedForMatch() {
    const stored = readStoredKit();
    if (stored && stored.placed && stored.placed.length) return stored.placed;
    const g = game();
    if (g && g._mapKitPlaced && g._mapKitPlaced.length) return g._mapKitPlaced.slice();
    if (state.placed && state.placed.length) return state.placed.slice();
    const def = getDefaultKitPlaced();
    if (def) return def;
    return [];
  }

  function resolveTerrainForMatch() {
    const stored = readStoredKit();
    if (stored && stored.active && stored.terrain && stored.terrain.data) {
      return stored.terrain;
    }
    const g = game();
    if (g && g._mapKitTerrain && g._mapKitTerrain.data) return g._mapKitTerrain;
    if (state.terrain && state.terrain.data) return state.terrain;
    return null;
  }

  function applyMatchMap() {
    const placed = resolvePlacedForMatch();
    const stored = readStoredKit();
    const skipSave = !(stored && stored.active);
    const terrain = resolveTerrainForMatch();
    if (terrain) state.terrain = terrain;
    else if (!(stored && stored.active) && !(game() && game()._mapKitTerrain)) {
      state.terrain = null;
    }
    return applyKitToWorld(placed || [], {
      skipSave: skipSave,
      terrain: terrain != null ? terrain : state.terrain,
    });
  }

  function loadDust2Default() {
    const def = getDefaultKitPlaced();
    if (!def || !def.length) {
      setStatus('未找到默认布局');
      return;
    }
    if (!ensureWorldReady()) return;
    state.genPreview = null;
    applyKitToWorld(def, { skipSave: false, terrain: null });
    invalidateAndRedraw();
    syncCount();
    syncApplyGenBtn();
    setStatus('已载入默认地图 · 可继续编辑');
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('已载入默认地图');
    }
  }

  /** True if cell is too close to a fixed base / gate corridor. */
  function cellNearBase(gx, gz) {
    const w = world();
    const size = (w && w.worldSize) || 320;
    const ax = size * 0.18;
    const az = size * 0.22;
    const ex = size * 0.82;
    const ez = size * 0.78;
    const cx = gx * GRID + GRID * 0.5;
    const cz = gz * GRID + GRID * 0.5;
    if (Math.abs(cx - ax) < 28 && Math.abs(cz - az) < 28) return true;
    if (Math.abs(cx - ex) < 28 && Math.abs(cz - ez) < 28) return true;
    // Gate corridors
    if (Math.abs(cx - ax) <= 20 && cz >= az && cz <= az + 52) return true;
    if (Math.abs(cx - ex) <= 20 && cz <= ez && cz >= ez - 52) return true;
    return false;
  }

  const SEM = { OPEN: 0, WATER: 1, ROAD: 2, PARK: 3, BUILT: 4 };
  const SEM_CELLS = 40;
  const SEM_SAMPLE = 160;

  function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 1e-6) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max <= 1e-6 ? 0 : d / max;
    return { h: h, s: s, v: max };
  }

  function classifyMapPixel(r, g, b) {
    const hsv = rgbToHsv(r, g, b);
    const h = hsv.h;
    const s = hsv.s;
    const v = hsv.v;
    // Water — blue / cyan map fills
    if (s > 0.14 && v > 0.22 && v < 0.95 && h >= 165 && h <= 255) return SEM.WATER;
    if (b > r + 22 && b > g + 12 && b > 70 && s > 0.1) return SEM.WATER;
    // Park / vegetation
    if (s > 0.14 && h >= 68 && h <= 165 && v > 0.22 && g >= r - 5 && g > b * 0.8) {
      return SEM.PARK;
    }
    // Bright roads / pale pavement
    if (v > 0.78 && s < 0.22) return SEM.ROAD;
    // Green highway casing
    if (s > 0.22 && h >= 95 && h <= 145 && v > 0.4 && v < 0.88 && Math.abs(r - g) < 50) {
      return SEM.ROAD;
    }
    // Built-up beige / grey blocks
    if (s < 0.3 && v > 0.32 && v < 0.84 && !(g > r + 18 && g > b + 8)) return SEM.BUILT;
    if (s < 0.38 && v > 0.38 && v < 0.78 && Math.abs(r - g) < 32 && Math.abs(g - b) < 40) {
      return SEM.BUILT;
    }
    return SEM.OPEN;
  }

  function cropMapChrome(img) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const top = Math.floor(ih * 0.1);
    const bot = Math.floor(ih * 0.12);
    const left = Math.floor(iw * 0.02);
    const right = Math.floor(iw * 0.02);
    const cw = Math.max(8, iw - left - right);
    const ch = Math.max(8, ih - top - bot);
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, left, top, cw, ch, 0, 0, cw, ch);
    return c;
  }

  function sampleImageToGrid(imgOrCanvas, size) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    const iw = imgOrCanvas.width || imgOrCanvas.naturalWidth;
    const ih = imgOrCanvas.height || imgOrCanvas.naturalHeight;
    const scale = Math.max(size / iw, size / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const ox = (size - dw) * 0.5;
    const oy = (size - dh) * 0.5;
    ctx.fillStyle = '#1a1c20';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(imgOrCanvas, ox, oy, dw, dh);
    return ctx.getImageData(0, 0, size, size);
  }

  function detectMapMode(data) {
    const n = data.width * data.height;
    let water = 0;
    let park = 0;
    let colorful = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const cls = classifyMapPixel(data.data[o], data.data[o + 1], data.data[o + 2]);
      if (cls === SEM.WATER) water++;
      if (cls === SEM.PARK) park++;
      const hsv = rgbToHsv(data.data[o], data.data[o + 1], data.data[o + 2]);
      if (hsv.s > 0.2) colorful++;
    }
    const mapLike = water + park > n * 0.06 || colorful > n * 0.22;
    return mapLike ? 'map' : 'radar';
  }

  function aggregateSemantic(hiData, hiSize, cells) {
    const grid = new Uint8Array(cells * cells);
    const counts = new Uint8Array(cells * cells * 5);
    const step = hiSize / cells;
    const pixPerCell = Math.max(1, Math.floor(step * step));
    for (let y = 0; y < hiSize; y++) {
      for (let x = 0; x < hiSize; x++) {
        const o = (y * hiSize + x) * 4;
        const cls = classifyMapPixel(hiData.data[o], hiData.data[o + 1], hiData.data[o + 2]);
        const gx = Math.min(cells - 1, Math.floor(x / step));
        const gz = Math.min(cells - 1, Math.floor(y / step));
        counts[(gz * cells + gx) * 5 + cls]++;
      }
    }
    for (let i = 0; i < cells * cells; i++) {
      const waterN = counts[i * 5 + SEM.WATER];
      // Water veto: ≥35% of cell pixels → water
      if (waterN >= pixPerCell * 0.35) {
        grid[i] = SEM.WATER;
        continue;
      }
      let best = SEM.OPEN;
      let bestN = -1;
      for (let c = 0; c < 5; c++) {
        if (c === SEM.WATER) continue;
        let n = counts[i * 5 + c];
        // Boost built-up so beige blocks aren't eaten by bright roads
        if (c === SEM.BUILT) n = Math.floor(n * 1.35) + 1;
        if (c === SEM.ROAD) n = Math.floor(n * 1.1);
        if (n > bestN) {
          bestN = n;
          best = c;
        }
      }
      grid[i] = best;
    }
    return refineSemanticGrid(grid, cells);
  }

  /** Dilate water 1 cell; demote BUILT that sits on/next to water. */
  function refineSemanticGrid(grid, cells) {
    const out = new Uint8Array(grid);
    const idx = function (gx, gz) {
      return gz * cells + gx;
    };
    // Water dilate
    for (let gz = 0; gz < cells; gz++) {
      for (let gx = 0; gx < cells; gx++) {
        if (grid[idx(gx, gz)] !== SEM.WATER) continue;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx < 0 || nz < 0 || nx >= cells || nz >= cells) continue;
            const j = idx(nx, nz);
            if (out[j] === SEM.BUILT || out[j] === SEM.OPEN) out[j] = SEM.WATER;
          }
        }
      }
    }
    // BUILT with ≥2 water neighbors → OPEN
    for (let gz = 0; gz < cells; gz++) {
      for (let gx = 0; gx < cells; gx++) {
        const j = idx(gx, gz);
        if (out[j] !== SEM.BUILT) continue;
        let wn = 0;
        const n4 = [
          [gx + 1, gz],
          [gx - 1, gz],
          [gx, gz + 1],
          [gx, gz - 1],
        ];
        for (let k = 0; k < 4; k++) {
          const nx = n4[k][0];
          const nz = n4[k][1];
          if (nx < 0 || nz < 0 || nx >= cells || nz >= cells) continue;
          if (out[idx(nx, nz)] === SEM.WATER) wn++;
        }
        if (wn >= 2) out[j] = SEM.OPEN;
      }
    }
    return out;
  }

  function radarSemanticFromImage(imgOrCanvas, cells) {
    const data = sampleImageToGrid(imgOrCanvas, cells);
    const lum = new Float32Array(cells * cells);
    let sum = 0;
    for (let i = 0; i < cells * cells; i++) {
      const o = i * 4;
      const L = 0.299 * data.data[o] + 0.587 * data.data[o + 1] + 0.114 * data.data[o + 2];
      lum[i] = L;
      sum += L;
    }
    const mean = sum / (cells * cells);
    let wallCount = 0;
    for (let i = 0; i < lum.length; i++) {
      if (lum[i] > 40 && lum[i] < 200) wallCount++;
    }
    const wallHeavy = wallCount > cells * cells * 0.12;
    const grid = new Uint8Array(cells * cells);
    for (let i = 0; i < lum.length; i++) {
      const L = lum[i];
      if (L > 210) grid[i] = SEM.OPEN;
      else if (wallHeavy) {
        grid[i] = L > Math.max(38, mean * 0.85) && L < 205 ? SEM.BUILT : SEM.OPEN;
      } else {
        grid[i] = L < Math.min(120, mean * 0.9) ? SEM.BUILT : SEM.OPEN;
      }
    }
    return refineSemanticGrid(grid, cells);
  }

  function buildSemanticGrid(img) {
    const cropped = cropMapChrome(img);
    const hi = sampleImageToGrid(cropped, SEM_SAMPLE);
    const mode = detectMapMode(hi);
    let grid;
    if (mode === 'map') grid = aggregateSemantic(hi, SEM_SAMPLE, SEM_CELLS);
    else grid = radarSemanticFromImage(cropped, SEM_CELLS);
    return { grid: grid, mode: mode, cells: SEM_CELLS };
  }

  function kitFromSemanticGrid(grid, cells) {
    cells = cells || SEM_CELLS;
    const BRIDGE_CAP = 120;
    const MAX_SPAN = 12;
    const LANE_HALF = 1;
    const idx = function (gx, gz) {
      return gz * cells + gx;
    };
    const clsAt = function (gx, gz) {
      if (gx < 0 || gz < 0 || gx >= cells || gz >= cells) return -1;
      return grid[idx(gx, gz)];
    };
    const isLand = function (gx, gz) {
      const c = clsAt(gx, gz);
      return c === SEM.OPEN || c === SEM.ROAD || c === SEM.PARK || c === SEM.BUILT;
    };
    const isWater = function (gx, gz) {
      return clsAt(gx, gz) === SEM.WATER;
    };

    let wSumX = 0;
    let wN = 0;
    let waterCells = 0;
    for (let gz = 0; gz < cells; gz++) {
      for (let gx = 0; gx < cells; gx++) {
        if (isWater(gx, gz)) {
          wSumX += gx;
          wN++;
          waterCells++;
        }
      }
    }
    const waterCx = wN > 0 ? wSumX / wN : cells * 0.5;
    const aMax = Math.max(3, Math.floor(waterCx) - 2);
    const bMin = Math.min(cells - 4, Math.ceil(waterCx) + 2);

    // Diagonal lanes: blue base (SW) → red base (NE); mid straight, top/bot one-bend polylines
    const allyGx = Math.max(3, Math.min(cells - 4, Math.round(cells * 0.18)));
    const allyGz = Math.max(3, Math.min(cells - 4, Math.round(cells * 0.22)));
    const enemyGx = Math.max(3, Math.min(cells - 4, Math.round(cells * 0.82)));
    const enemyGz = Math.max(3, Math.min(cells - 4, Math.round(cells * 0.78)));

    function clampCell(v) {
      return Math.max(2, Math.min(cells - 3, Math.round(v)));
    }

    /** Bresenham line cells from (x0,z0) to (x1,z1) */
    function rasterLine(x0, z0, x1, z1) {
      const out = [];
      let x = Math.round(x0);
      let z = Math.round(z0);
      const xEnd = Math.round(x1);
      const zEnd = Math.round(z1);
      const dx = Math.abs(xEnd - x);
      const dz = Math.abs(zEnd - z);
      const sx = x < xEnd ? 1 : -1;
      const sz = z < zEnd ? 1 : -1;
      let err = dx - dz;
      for (;;) {
        out.push({ gx: x, gz: z });
        if (x === xEnd && z === zEnd) break;
        const e2 = err * 2;
        if (e2 > -dz) {
          err -= dz;
          x += sx;
        }
        if (e2 < dx) {
          err += dx;
          z += sz;
        }
      }
      return out;
    }

    function buildPolyline(points) {
      const cellsOut = [];
      const key = {};
      for (let i = 0; i < points.length - 1; i++) {
        const seg = rasterLine(points[i].gx, points[i].gz, points[i + 1].gx, points[i + 1].gz);
        for (let j = 0; j < seg.length; j++) {
          const c = seg[j];
          const k = c.gx + ',' + c.gz;
          if (key[k]) continue;
          key[k] = true;
          cellsOut.push(c);
        }
      }
      return cellsOut;
    }

    function laneDist(lane, gx, gz) {
      let best = 99;
      const cs = lane.cells;
      for (let i = 0; i < cs.length; i++) {
        const d = Math.max(Math.abs(cs[i].gx - gx), Math.abs(cs[i].gz - gz));
        if (d < best) best = d;
        if (best === 0) break;
      }
      return best;
    }

    /** Perp offset of mid-diagonal for top(+)/bot(-) bend waypoints */
    const dxLane = enemyGx - allyGx;
    const dzLane = enemyGz - allyGz;
    const lenLane = Math.sqrt(dxLane * dxLane + dzLane * dzLane) || 1;
    const perpX = -dzLane / lenLane;
    const perpZ = dxLane / lenLane;
    const bendOff = Math.max(5, Math.round(cells * 0.22));
    const alongOff = Math.max(4, Math.round(cells * 0.14));
    const midWx = (allyGx + enemyGx) * 0.5;
    const midWz = (allyGz + enemyGz) * 0.5;
    const alongX = dxLane / lenLane;
    const alongZ = dzLane / lenLane;
    // Keep through-bridges as thin ribbons — never merge into a deck blob
    const MIN_BRIDGE_SEP = Math.max(10, Math.round(cells * 0.24));

    const lanePointSets = [
      {
        id: 'mid',
        preferT: 0.5,
        points: [
          { gx: allyGx, gz: allyGz },
          { gx: enemyGx, gz: enemyGz },
        ],
      },
      {
        id: 'top',
        preferT: 0.32,
        points: [
          { gx: allyGx, gz: allyGz },
          {
            gx: clampCell(midWx + perpX * bendOff - alongX * alongOff),
            gz: clampCell(midWz + perpZ * bendOff - alongZ * alongOff),
          },
          { gx: enemyGx, gz: enemyGz },
        ],
      },
      {
        id: 'bot',
        preferT: 0.68,
        points: [
          { gx: allyGx, gz: allyGz },
          {
            gx: clampCell(midWx - perpX * bendOff + alongX * alongOff),
            gz: clampCell(midWz - perpZ * bendOff + alongZ * alongOff),
          },
          { gx: enemyGx, gz: enemyGz },
        ],
      },
    ];

    /** All land→water→land cuts on a path (width ≤ MAX_SPAN) */
    function collectPathCrossings(pathCells) {
      const out = [];
      let i = 0;
      while (i < pathCells.length) {
        while (i < pathCells.length && !isLand(pathCells[i].gx, pathCells[i].gz)) i++;
        if (i >= pathCells.length) break;
        while (i < pathCells.length && isLand(pathCells[i].gx, pathCells[i].gz)) i++;
        if (i >= pathCells.length || !isWater(pathCells[i].gx, pathCells[i].gz)) continue;
        const w0 = i;
        while (i < pathCells.length && isWater(pathCells[i].gx, pathCells[i].gz)) i++;
        const w1 = i - 1;
        if (i >= pathCells.length || !isLand(pathCells[i].gx, pathCells[i].gz)) continue;
        const width = w1 - w0 + 1;
        if (width < 1 || width > MAX_SPAN) continue;
        const waterCells = [];
        for (let wi = w0; wi <= w1; wi++) waterCells.push(pathCells[wi]);
        let midGx = 0;
        let midGz = 0;
        for (let wi = 0; wi < waterCells.length; wi++) {
          midGx += waterCells[wi].gx;
          midGz += waterCells[wi].gz;
        }
        midGx /= waterCells.length;
        midGz /= waterCells.length;
        const pathT = ((w0 + w1) * 0.5) / Math.max(1, pathCells.length - 1);
        out.push({
          waterCells: waterCells,
          mouth0: pathCells[w0 - 1],
          mouth1: pathCells[w1 + 1],
          width: width,
          midGx: midGx,
          midGz: midGz,
          pathT: pathT,
        });
      }
      return out;
    }

    function crossCells(cross) {
      const list = [];
      if (cross.mouth0) list.push(cross.mouth0);
      for (let i = 0; i < cross.waterCells.length; i++) list.push(cross.waterCells[i]);
      if (cross.mouth1) list.push(cross.mouth1);
      return list;
    }

    /** Chebyshev distance between two crossings (nearest cells) */
    function crossingCellSep(a, b) {
      const ca = crossCells(a);
      const cb = crossCells(b);
      let best = 99;
      for (let i = 0; i < ca.length; i++) {
        for (let j = 0; j < cb.length; j++) {
          const d = Math.max(Math.abs(ca[i].gx - cb[j].gx), Math.abs(ca[i].gz - cb[j].gz));
          if (d < best) best = d;
        }
      }
      return best;
    }

    function crossingNearPlaced(cross, placedCells, minSep) {
      const ca = crossCells(cross);
      for (let i = 0; i < ca.length; i++) {
        for (let j = 0; j < placedCells.length; j++) {
          const d = Math.max(
            Math.abs(ca[i].gx - placedCells[j].gx),
            Math.abs(ca[i].gz - placedCells[j].gz)
          );
          if (d < minSep) return true;
        }
      }
      return false;
    }

    /** Pick a cut far from existing bridges; return null rather than pile on */
    function pickLaneCrossing(pathCells, preferT, avoidList, placedCells) {
      const cands = collectPathCrossings(pathCells);
      if (!cands.length) return null;
      cands.sort(function (a, b) {
        let sepA = 99;
        let sepB = 99;
        for (let k = 0; k < avoidList.length; k++) {
          sepA = Math.min(sepA, crossingCellSep(a, avoidList[k]));
          sepB = Math.min(sepB, crossingCellSep(b, avoidList[k]));
        }
        const scoreA =
          Math.abs(a.pathT - preferT) * 10 +
          a.width * 0.5 +
          (sepA < MIN_BRIDGE_SEP ? (MIN_BRIDGE_SEP - sepA) * 8 : 0) -
          Math.min(sepA, 24) * 0.2;
        const scoreB =
          Math.abs(b.pathT - preferT) * 10 +
          b.width * 0.5 +
          (sepB < MIN_BRIDGE_SEP ? (MIN_BRIDGE_SEP - sepB) * 8 : 0) -
          Math.min(sepB, 24) * 0.2;
        return scoreA - scoreB;
      });
      for (let i = 0; i < cands.length; i++) {
        if (crossingNearPlaced(cands[i], placedCells, MIN_BRIDGE_SEP)) continue;
        let ok = true;
        for (let k = 0; k < avoidList.length; k++) {
          if (crossingCellSep(cands[i], avoidList[k]) < MIN_BRIDGE_SEP) {
            ok = false;
            break;
          }
        }
        if (ok) return cands[i];
      }
      // Do NOT fall back to a near/overlapping cut — skip bridge for this lane
      return null;
    }

    // Place mid first, then top/bot (must clear hard separation or skip)
    const activeLanes = [];
    const chosenCross = [];
    const placedBridgeCells = [];
    const order = ['mid', 'top', 'bot'];
    const defById = {};
    for (let i = 0; i < lanePointSets.length; i++) {
      defById[lanePointSets[i].id] = lanePointSets[i];
    }
    for (let oi = 0; oi < order.length; oi++) {
      const def = defById[order[oi]];
      if (!def) continue;
      const pathCells = buildPolyline(def.points);
      if (pathCells.length < 4) continue;
      const cross = pickLaneCrossing(pathCells, def.preferT, chosenCross, placedBridgeCells);
      if (cross) {
        chosenCross.push(cross);
        const cc = crossCells(cross);
        for (let ci = 0; ci < cc.length; ci++) placedBridgeCells.push(cc[ci]);
      }
      activeLanes.push({
        id: def.id,
        points: def.points,
        cells: pathCells,
        cross: cross,
      });
    }
    if (!activeLanes.length) {
      const pathCells = buildPolyline([
        { gx: allyGx, gz: allyGz },
        { gx: enemyGx, gz: enemyGz },
      ]);
      const cross = pickLaneCrossing(pathCells, 0.5, [], []);
      activeLanes.push({
        id: 'mid',
        points: [
          { gx: allyGx, gz: allyGz },
          { gx: enemyGx, gz: enemyGz },
        ],
        cells: pathCells,
        cross: cross,
      });
    }

    const bridgeCells = [];
    const bridgeKey = {};
    const addBridge = function (gx, gz) {
      if (bridgeCells.length >= BRIDGE_CAP) return;
      if (gx < 2 || gz < 2 || gx >= cells - 2 || gz >= cells - 2) return;
      if (cellNearBase(gx, gz)) return;
      const k = gx + ',' + gz;
      if (bridgeKey[k]) return;
      bridgeKey[k] = true;
      bridgeCells.push({ gx: gx, gz: gz });
    };

    const catCells = [];
    const catKey = {};
    const bridgeMouths = [];

    // Thin through-ribbon only (no perpendicular fill — that caused the deck blob)
    for (let i = 0; i < activeLanes.length; i++) {
      const L = activeLanes[i];
      if (!L.cross) continue;
      const s = L.cross;
      addBridge(s.mouth0.gx, s.mouth0.gz);
      for (let wi = 0; wi < s.waterCells.length; wi++) {
        addBridge(s.waterCells[wi].gx, s.waterCells[wi].gz);
      }
      addBridge(s.mouth1.gx, s.mouth1.gz);
      bridgeMouths.push(
        { gx: s.mouth0.gx, gz: s.mouth0.gz },
        { gx: s.mouth1.gx, gz: s.mouth1.gz }
      );
      if (L.id === 'mid') {
        for (let wi = 0; wi < s.waterCells.length; wi++) {
          const wc = s.waterCells[wi];
          const ck = wc.gx + ',' + wc.gz;
          if (catKey[ck]) continue;
          catKey[ck] = true;
          catCells.push({ gx: wc.gx, gz: wc.gz });
        }
      }
      const midIdx = Math.floor(s.waterCells.length / 2);
      L.cross.midCell = s.waterCells[midIdx] || s.mouth0;
    }

    function nearBridgeMouth(gx, gz, rad) {
      rad = rad != null ? rad : 2;
      for (let i = 0; i < bridgeMouths.length; i++) {
        const m = bridgeMouths[i];
        if (Math.abs(m.gx - gx) <= rad && Math.abs(m.gz - gz) <= rad) return true;
      }
      return false;
    }

    function footprintClear(cgx, cgz, kind) {
      if (isWater(cgx, cgz) || cellNearBase(cgx, cgz)) return false;
      const corners = [
        [cgx, cgz],
        [cgx + 1, cgz],
        [cgx - 1, cgz],
        [cgx, cgz + 1],
        [cgx, cgz - 1],
      ];
      if (kind === 'factory' || kind === 'skyscraper') {
        corners.push([cgx + 1, cgz + 1], [cgx - 1, cgz - 1]);
      }
      for (let i = 0; i < corners.length; i++) {
        const x = corners[i][0];
        const z = corners[i][1];
        if (x < 0 || z < 0 || x >= cells || z >= cells) continue;
        if (isWater(x, z)) return false;
      }
      return true;
    }

    function collectCandidates(targetCls, minN, allowKinds) {
      const seen = new Uint8Array(cells * cells);
      const out = [];
      const stack = [];
      for (let gz = 0; gz < cells; gz++) {
        for (let gx = 0; gx < cells; gx++) {
          const i0 = idx(gx, gz);
          if (grid[i0] !== targetCls || seen[i0]) continue;
          if (cellNearBase(gx, gz) || isWater(gx, gz)) continue;
          stack.length = 0;
          stack.push(gx, gz);
          seen[i0] = 1;
          let minX = gx;
          let maxX = gx;
          let minZ = gz;
          let maxZ = gz;
          let n = 0;
          let sx = 0;
          let sz = 0;
          let waterIn = 0;
          while (stack.length) {
            const cy = stack.pop();
            const cx = stack.pop();
            n++;
            sx += cx;
            sz += cy;
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minZ) minZ = cy;
            if (cy > maxZ) maxZ = cy;
            const n4 = [
              [cx + 1, cy],
              [cx - 1, cy],
              [cx, cy + 1],
              [cx, cy - 1],
            ];
            for (let k = 0; k < 4; k++) {
              const nx = n4[k][0];
              const nz = n4[k][1];
              if (clsAt(nx, nz) !== targetCls) {
                if (isWater(nx, nz)) waterIn++;
                continue;
              }
              const j = idx(nx, nz);
              if (seen[j]) continue;
              seen[j] = 1;
              stack.push(nx, nz);
            }
          }
          if (n < minN) continue;
          const area = (maxX - minX + 1) * (maxZ - minZ + 1);
          if (waterIn > Math.max(1, area * 0.1)) continue;
          const cgx = Math.round(sx / n);
          const cgz = Math.round(sz / n);
          if (isWater(cgx, cgz) || cellNearBase(cgx, cgz)) continue;
          const span = Math.max(maxX - minX + 1, maxZ - minZ + 1);
          let kind = 'ruin';
          if (allowKinds) {
            if (n >= 28 || span >= 5) kind = 'factory';
            else if (n >= 14 || span >= 4) kind = 'skyscraper';
            else if (n >= 8 || span >= 3) kind = 'midrise';
            else if (n >= 4) kind = 'house';
            else kind = 'ruin';
          } else {
            kind = n >= 6 ? 'house' : 'ruin';
          }
          if (!footprintClear(cgx, cgz, kind)) continue;
          out.push({
            kind: kind,
            cx: cgx * GRID + GRID * 0.5,
            cz: cgz * GRID + GRID * 0.5,
            yaw: maxX - minX > maxZ - minZ ? 90 : 0,
            _gx: cgx,
            _gz: cgz,
            _n: n,
          });
        }
      }
      return out;
    }

    let candidates = collectCandidates(SEM.BUILT, 2, true);
    const openCand = collectCandidates(SEM.OPEN, 3, false);
    const candKey = {};
    for (let i = 0; i < candidates.length; i++) {
      candKey[candidates[i]._gx + ',' + candidates[i]._gz] = true;
    }
    for (let i = 0; i < openCand.length; i++) {
      const o = openCand[i];
      const k = o._gx + ',' + o._gz;
      if (candKey[k]) continue;
      candKey[k] = true;
      candidates.push(o);
    }

    // Score: prefer shoulder of lanes; tag nearest lane for even buckets + flavor
    function nearestLaneId(gx, gz) {
      let laneId = 'mid';
      let bestD = 99;
      for (let li = 0; li < activeLanes.length; li++) {
        const d = laneDist(activeLanes[li], gx, gz);
        if (d < bestD) {
          bestD = d;
          laneId = activeLanes[li].id;
        }
      }
      return { id: laneId, d: bestD };
    }

    function flavorKind(laneId, idx, preferBigger) {
      if (laneId === 'top') {
        return idx % 4 === 0 ? 'house' : 'ruin';
      }
      if (laneId === 'bot') {
        if (preferBigger && idx % 5 === 0) return 'factory';
        return idx % 3 === 0 ? 'ruin' : 'house';
      }
      // mid urban
      if (preferBigger && idx % 7 === 0) return 'skyscraper';
      if (idx % 3 === 0) return 'midrise';
      return 'house';
    }

    function remapKindToLane(laneId, kind, idx) {
      if (laneId === 'top') {
        if (kind === 'factory' || kind === 'skyscraper' || kind === 'midrise') return 'ruin';
        return kind === 'house' ? 'house' : 'ruin';
      }
      if (laneId === 'bot') {
        if (kind === 'skyscraper' || kind === 'midrise') return 'factory';
        if (kind === 'ruin') return idx % 2 === 0 ? 'ruin' : 'house';
        return kind === 'factory' ? 'factory' : 'house';
      }
      // mid
      if (kind === 'factory') return 'midrise';
      if (kind === 'ruin') return 'house';
      return kind;
    }

    const scored = [];
    for (let i = 0; i < candidates.length; i++) {
      const b = candidates[i];
      const near = nearestLaneId(b._gx, b._gz);
      const dLane = near.d;
      const onShore = b._gx <= aMax || b._gx >= bMin;
      // Allow a wider shoulder so buildings can spread off the path
      if (dLane > 10) continue;
      if (nearBridgeMouth(b._gx, b._gz, 2)) continue;
      const onCenter = dLane === 0;
      let score = 8 - Math.min(dLane, 6);
      if (dLane >= 2 && dLane <= 5) score += 3;
      if (onShore && dLane <= 6) score += 1;
      if (onCenter) score -= 8;
      // Prefer spread along the diagonal (hash breaks local clumps)
      score += ((b._gx * 17 + b._gz * 31) % 7) * 0.15;
      scored.push({
        b: b,
        score: score,
        dLane: dLane,
        laneId: near.id,
        side: b._gx <= waterCx ? 'A' : 'B',
        along: b._gx + b._gz,
        used: false,
      });
    }
    scored.sort(function (a, b) {
      return b.score - a.score || a.along - b.along;
    });

    const buildings = [];
    const perLaneSide = {};
    const targetPerBucket = 5;
    const maxPerLaneSide = 6;
    const maxTotal = 36;
    // ~5 cells between building centers — keep map readable, not clustered
    const MIN_BUILDING_DIST2 = 25;
    const bucketKeys = [];
    for (let li = 0; li < activeLanes.length; li++) {
      bucketKeys.push(activeLanes[li].id + 'A');
      bucketKeys.push(activeLanes[li].id + 'B');
    }
    function lowestBucketCount() {
      let m = 99;
      for (let i = 0; i < bucketKeys.length; i++) {
        m = Math.min(m, perLaneSide[bucketKeys[i]] || 0);
      }
      return m;
    }
    function minDist2ToBuildings(gx, gz) {
      let best = 1e9;
      for (let j = 0; j < buildings.length; j++) {
        const dx = buildings[j]._gx - gx;
        const dz = buildings[j]._gz - gz;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
      return best;
    }
    function tryAddBuilding(b, laneId, side, kind) {
      const key = laneId + side;
      const n = perLaneSide[key] || 0;
      if (n >= maxPerLaneSide || buildings.length >= maxTotal) return false;
      // Prefer filling underfilled buckets first
      if (n > lowestBucketCount() && n >= targetPerBucket) return false;
      if (minDist2ToBuildings(b._gx, b._gz) < MIN_BUILDING_DIST2) return false;
      const useKind = kind || remapKindToLane(laneId, b.kind, buildings.length);
      if (!footprintClear(b._gx, b._gz, useKind)) return false;
      perLaneSide[key] = n + 1;
      buildings.push({
        kind: useKind,
        cx: b.cx,
        cz: b.cz,
        yaw: b.yaw,
        _gx: b._gx,
        _gz: b._gz,
        _n: b._n,
        _lane: laneId,
        _side: side,
      });
      return true;
    }

    // Round-robin by lane×side: each turn pick farthest-from-existing high-score cand
    function pickBestForBucket(laneId, side) {
      let best = null;
      let bestVal = -1e9;
      for (let i = 0; i < scored.length; i++) {
        const s = scored[i];
        if (s.used || s.laneId !== laneId || s.side !== side) continue;
        const d2 = minDist2ToBuildings(s.b._gx, s.b._gz);
        if (d2 < MIN_BUILDING_DIST2) continue;
        // Reward spread: score + distance-to-nearest-building
        const val = s.score + Math.sqrt(d2) * 1.4;
        if (val > bestVal) {
          bestVal = val;
          best = s;
        }
      }
      return best;
    }
    let progressed = true;
    while (progressed && buildings.length < maxTotal) {
      progressed = false;
      const low = lowestBucketCount();
      for (let bi = 0; bi < bucketKeys.length; bi++) {
        if (buildings.length >= maxTotal) break;
        const key = bucketKeys[bi];
        const n = perLaneSide[key] || 0;
        if (n >= maxPerLaneSide) continue;
        // Keep buckets roughly even: don't run ahead of the lowest by >1 until target
        if (n > low + 1) continue;
        if (n >= targetPerBucket && n > low) continue;
        const laneId = key.slice(0, -1);
        const side = key.slice(-1);
        const s = pickBestForBucket(laneId, side);
        if (!s) continue;
        if (tryAddBuilding(s.b, laneId, side, null)) {
          s.used = true;
          progressed = true;
        } else {
          s.used = true;
        }
      }
    }
    // Second pass: fill remaining slots with relaxed evenness
    progressed = true;
    while (progressed && buildings.length < maxTotal) {
      progressed = false;
      for (let bi = 0; bi < bucketKeys.length; bi++) {
        if (buildings.length >= maxTotal) break;
        const key = bucketKeys[bi];
        const n = perLaneSide[key] || 0;
        if (n >= maxPerLaneSide) continue;
        const laneId = key.slice(0, -1);
        const side = key.slice(-1);
        const s = pickBestForBucket(laneId, side);
        if (!s) continue;
        if (tryAddBuilding(s.b, laneId, side, null)) {
          s.used = true;
          progressed = true;
        } else {
          s.used = true;
        }
      }
    }

    // Pad underfilled buckets with lane-flavored shoulder cover along path
    function padBucket(laneId, side, need) {
      let L = null;
      for (let li = 0; li < activeLanes.length; li++) {
        if (activeLanes[li].id === laneId) {
          L = activeLanes[li];
          break;
        }
      }
      if (!L || need <= 0 || !L.cells.length) return;
      const gx0 = side === 'A' ? 4 : bMin;
      const gx1 = side === 'A' ? aMax : cells - 5;
      // Coarser path step so pad buildings also stay spaced
      const step = Math.max(3, Math.floor(L.cells.length / 12));
      for (let shoulder = 2; shoulder <= 5 && (perLaneSide[laneId + side] || 0) < need; shoulder++) {
        for (let sign = -1; sign <= 1; sign += 2) {
          for (let ci = 0; ci < L.cells.length; ci += step) {
            if ((perLaneSide[laneId + side] || 0) >= need) return;
            const pc = L.cells[ci];
            if (pc.gx < gx0 || pc.gx > gx1) continue;
            const gx = clampCell(pc.gx + Math.round(perpX * sign * shoulder));
            const gz = clampCell(pc.gz + Math.round(perpZ * sign * shoulder));
            if (gx < 3 || gz < 3 || gx >= cells - 3 || gz >= cells - 3) continue;
            if (!isLand(gx, gz) || isWater(gx, gz)) continue;
            if (cellNearBase(gx, gz) || nearBridgeMouth(gx, gz, 2)) continue;
            if (bridgeKey[gx + ',' + gz]) continue;
            if (laneDist(L, gx, gz) > shoulder + 1) continue;
            const kind = flavorKind(laneId, buildings.length, false);
            if (!footprintClear(gx, gz, kind)) continue;
            tryAddBuilding(
              {
                kind: kind,
                cx: gx * GRID + GRID * 0.5,
                cz: gz * GRID + GRID * 0.5,
                yaw: sign > 0 ? 0 : 90,
                _gx: gx,
                _gz: gz,
                _n: 1,
              },
              laneId,
              side,
              kind
            );
          }
        }
      }
    }
    for (let i = 0; i < bucketKeys.length; i++) {
      const key = bucketKeys[i];
      const cur = perLaneSide[key] || 0;
      if (cur < targetPerBucket) {
        padBucket(key.slice(0, -1), key.slice(-1), targetPerBucket);
      }
    }

    // Spawns: one kit crystal per lane per shore (3 per team + base = 4)
    // Constrained to diagonal halves: ally SW, enemy NE (bases at ~0.18/0.22 vs 0.82/0.78)
    const spawns = [];
    const diagDen = Math.max(1, cells - 1);
    const wSize = (world() && world().worldSize) || cells * GRID;
    const allyBaseX = wSize * 0.18;
    const allyBaseZ = wSize * 0.22;
    const enemyBaseX = wSize * 0.82;
    const enemyBaseZ = wSize * 0.78;
    const OPP_BASE_R2 = 40 * 40; // world units (~5 cells)

    function diagT(gx, gz) {
      return (gx + gz) / diagDen;
    }
    function inTeamHalf(team, gx, gz) {
      const t = diagT(gx, gz);
      if (team === 'enemy') return t >= 1.08;
      return t <= 0.92;
    }
    function tooNearEnemyBase(team, gx, gz) {
      const cx = gx * GRID + GRID * 0.5;
      const cz = gz * GRID + GRID * 0.5;
      if (team === 'ally') {
        const dx = cx - enemyBaseX;
        const dz = cz - enemyBaseZ;
        return dx * dx + dz * dz < OPP_BASE_R2;
      }
      const dx = cx - allyBaseX;
      const dz = cz - allyBaseZ;
      return dx * dx + dz * dz < OPP_BASE_R2;
    }
    const midX = wSize * 0.5;
    const midZ = wSize * 0.5;
    /** Reject cells behind own base (away from map center). */
    function behindOwnBase(team, gx, gz) {
      const ownBx = team === 'enemy' ? enemyBaseX : allyBaseX;
      const ownBz = team === 'enemy' ? enemyBaseZ : allyBaseZ;
      const cx = gx * GRID + GRID * 0.5;
      const cz = gz * GRID + GRID * 0.5;
      const vx = midX - ownBx;
      const vz = midZ - ownBz;
      const px = cx - ownBx;
      const pz = cz - ownBz;
      return px * vx + pz * vz < GRID * 2;
    }
    /** Player crystals: half + mid-band (not deep corners) */
    function inTeamSpawnBand(team, gx, gz) {
      const t = diagT(gx, gz);
      if (team === 'enemy') return t >= 1.08 && t <= 1.42;
      return t >= 0.58 && t <= 0.92;
    }
    function collectSpawnCandidates(team, gzLo, gzHi, gx0, gx1) {
      const prefer = [];
      for (let gz = gzLo; gz <= gzHi; gz++) {
        if (gz < 3 || gz >= cells - 3) continue;
        for (let gx = gx0; gx <= gx1; gx++) {
          if (!isLand(gx, gz) || isWater(gx, gz)) continue;
          if (cellNearBase(gx, gz)) continue;
          if (!inTeamSpawnBand(team, gx, gz)) continue;
          if (behindOwnBase(team, gx, gz)) continue;
          if (tooNearEnemyBase(team, gx, gz)) continue;
          if (bridgeKey[gx + ',' + gz]) continue;
          if (nearBridgeMouth(gx, gz, 1)) continue;
          let nearTeam = false;
          for (let si = 0; si < spawns.length; si++) {
            if (spawns[si].team !== team) continue;
            const sgx = Math.floor(spawns[si].cx / GRID);
            const sgz = Math.floor(spawns[si].cz / GRID);
            const dx = sgx - gx;
            const dz = sgz - gz;
            if (dx * dx + dz * dz < 9) {
              nearTeam = true;
              break;
            }
          }
          if (nearTeam) continue;
          const edge =
            clsAt(gx, gz) === SEM.ROAD ||
            clsAt(gx + 1, gz) === SEM.ROAD ||
            clsAt(gx - 1, gz) === SEM.ROAD
              ? 0
              : 1;
          const midScore = Math.abs(diagT(gx, gz) - 1);
          const cx = gx * GRID + GRID * 0.5;
          const cz = gz * GRID + GRID * 0.5;
          const toMid = (cx - midX) * (cx - midX) + (cz - midZ) * (cz - midZ);
          prefer.push({ gx: gx, gz: gz, edge: edge, midScore: midScore, toMid: toMid });
        }
      }
      prefer.sort(function (a, b) {
        if (a.edge !== b.edge) return a.edge - b.edge;
        if (a.midScore !== b.midScore) return a.midScore - b.midScore;
        return a.toMid - b.toMid;
      });
      return prefer;
    }
    function pickSpawnOnLane(team, lane, gx0, gx1) {
      if (!lane || !lane.cells || !lane.cells.length) return false;
      const samples = [];
      const step = Math.max(1, Math.floor(lane.cells.length / 20));
      for (let ci = 0; ci < lane.cells.length; ci += step) {
        const pc = lane.cells[ci];
        if (pc.gx < gx0 || pc.gx > gx1) continue;
        // Prefer own half, but still sample near shore for later loose fill
        samples.push(pc);
      }
      function gatherNearSamples(rad, loose) {
        const prefer = [];
        const seen = {};
        for (let si = 0; si < samples.length; si++) {
          const pc = samples[si];
          for (let dz = -rad; dz <= rad; dz++) {
            for (let dx = -rad; dx <= rad; dx++) {
              const gx = pc.gx + dx;
              const gz = pc.gz + dz;
              const k = gx + ',' + gz;
              if (seen[k]) continue;
              seen[k] = true;
              if (gx < Math.max(3, gx0 - (loose ? 4 : 0)) || gx > Math.min(cells - 4, gx1 + (loose ? 4 : 0)))
                continue;
              if (!isLand(gx, gz) || isWater(gx, gz)) continue;
              if (cellNearBase(gx, gz)) continue;
              if (!loose) {
                if (!inTeamHalf(team, gx, gz)) continue;
                if (!inTeamSpawnBand(team, gx, gz)) continue;
                if (behindOwnBase(team, gx, gz)) continue;
              } else {
                // Soft half: still same diagonal side of mid
                const t = diagT(gx, gz);
                if (team === 'ally' && t > 1.02) continue;
                if (team === 'enemy' && t < 0.98) continue;
                if (behindOwnBase(team, gx, gz)) continue;
              }
              if (tooNearEnemyBase(team, gx, gz)) continue;
              if (bridgeKey[gx + ',' + gz]) continue;
              if (nearBridgeMouth(gx, gz, 1)) continue;
              if (laneDist(lane, gx, gz) > rad + LANE_HALF + (loose ? 2 : 0)) continue;
              let nearTeam = false;
              for (let ti = 0; ti < spawns.length; ti++) {
                if (spawns[ti].team !== team) continue;
                const sgx = Math.floor(spawns[ti].cx / GRID);
                const sgz = Math.floor(spawns[ti].cz / GRID);
                const tdx = sgx - gx;
                const tdz = sgz - gz;
                if (tdx * tdx + tdz * tdz < 9) {
                  nearTeam = true;
                  break;
                }
              }
              if (nearTeam) continue;
              const edge =
                clsAt(gx, gz) === SEM.ROAD ||
                clsAt(gx + 1, gz) === SEM.ROAD ||
                clsAt(gx - 1, gz) === SEM.ROAD
                  ? 0
                  : 1;
              const midScore = Math.abs(diagT(gx, gz) - 1);
              const cx = gx * GRID + GRID * 0.5;
              const cz = gz * GRID + GRID * 0.5;
              const toMid = (cx - midX) * (cx - midX) + (cz - midZ) * (cz - midZ);
              prefer.push({ gx: gx, gz: gz, edge: edge, midScore: midScore, toMid: toMid });
            }
          }
        }
        prefer.sort(function (a, b) {
          if (a.edge !== b.edge) return a.edge - b.edge;
          if (a.midScore !== b.midScore) return a.midScore - b.midScore;
          return a.toMid - b.toMid;
        });
        return prefer;
      }
      let prefer = gatherNearSamples(LANE_HALF + 1, false);
      if (!prefer.length) prefer = gatherNearSamples(4, false);
      if (!prefer.length) prefer = gatherNearSamples(5, true);
      if (!prefer.length) {
        let minZ = cells;
        let maxZ = 0;
        for (let ci = 0; ci < lane.cells.length; ci++) {
          const pc = lane.cells[ci];
          if (pc.gx < gx0 - 2 || pc.gx > gx1 + 2) continue;
          if (pc.gz < minZ) minZ = pc.gz;
          if (pc.gz > maxZ) maxZ = pc.gz;
        }
        if (minZ <= maxZ) {
          prefer = collectSpawnCandidates(team, minZ - 3, maxZ + 3, gx0 - 2, gx1 + 2).filter(
            function (p) {
              return laneDist(lane, p.gx, p.gz) <= 8;
            }
          );
        }
      }
      if (!prefer.length) return false;
      return pushKitSpawn(team, prefer[0].gx, prefer[0].gz);
    }

    function pushKitSpawn(team, gx, gz) {
      if (gx < 3 || gz < 3 || gx >= cells - 3 || gz >= cells - 3) return false;
      if (!isLand(gx, gz) || isWater(gx, gz)) return false;
      if (cellNearBase(gx, gz) || bridgeKey[gx + ',' + gz]) return false;
      for (let ti = 0; ti < spawns.length; ti++) {
        if (spawns[ti].team !== team) continue;
        const sgx = Math.floor(spawns[ti].cx / GRID);
        const sgz = Math.floor(spawns[ti].cz / GRID);
        const tdx = sgx - gx;
        const tdz = sgz - gz;
        if (tdx * tdx + tdz * tdz < 9) return false;
      }
      const cx = gx * GRID + GRID * 0.5;
      const cz = gz * GRID + GRID * 0.5;
      spawns.push({
        kind: 'spawn',
        team: team,
        cx: cx,
        cz: cz,
        x: cx,
        z: cz,
        w: GRID,
        d: GRID,
        ox: Math.floor(cx - GRID * 0.5),
        oz: Math.floor(cz - GRID * 0.5),
        yaw: 0,
      });
      return true;
    }

    function countKit(team) {
      let n = 0;
      for (let i = 0; i < spawns.length; i++) {
        if (spawns[i].team === team) n++;
      }
      return n;
    }

    /** Fill missing kit crystals so both teams reach KIT_PER_TEAM */
    function fillTeamKitSpawns(team, need) {
      if (need <= 0) return;
      const gx0 = team === 'ally' ? 3 : Math.max(bMin - 4, Math.floor(cells * 0.32));
      const gx1 = team === 'ally' ? Math.min(aMax + 6, Math.ceil(cells * 0.68)) : cells - 4;
      function collectFill(skipBehind) {
        const cands = [];
        for (let gz = 3; gz < cells - 3; gz++) {
          for (let gx = gx0; gx <= gx1; gx++) {
            if (!isLand(gx, gz) || isWater(gx, gz)) continue;
            if (cellNearBase(gx, gz)) continue;
            const t = diagT(gx, gz);
            if (team === 'ally' && t > 1.02) continue;
            if (team === 'enemy' && t < 0.98) continue;
            if (!skipBehind && behindOwnBase(team, gx, gz)) continue;
            if (tooNearEnemyBase(team, gx, gz)) continue;
            if (bridgeKey[gx + ',' + gz] || nearBridgeMouth(gx, gz, 1)) continue;
            let dLane = 99;
            for (let li = 0; li < activeLanes.length; li++) {
              dLane = Math.min(dLane, laneDist(activeLanes[li], gx, gz));
            }
            const midScore = Math.abs(t - 1);
            cands.push({ gx: gx, gz: gz, dLane: dLane, midScore: midScore });
          }
        }
        cands.sort(function (a, b) {
          if (a.dLane !== b.dLane) return a.dLane - b.dLane;
          return a.midScore - b.midScore;
        });
        return cands;
      }
      let got = 0;
      let cands = collectFill(false);
      for (let i = 0; i < cands.length && got < need; i++) {
        if (pushKitSpawn(team, cands[i].gx, cands[i].gz)) got++;
      }
      if (got < need) {
        cands = collectFill(true);
        for (let i = 0; i < cands.length && got < need; i++) {
          if (pushKitSpawn(team, cands[i].gx, cands[i].gz)) got++;
        }
      }
    }

    const KIT_PER_TEAM = 3;
    const spawnLanes = activeLanes.slice();
    for (let i = 0; i < spawnLanes.length && i < 3; i++) {
      pickSpawnOnLane('ally', spawnLanes[i], 4, aMax);
      pickSpawnOnLane('enemy', spawnLanes[i], bMin, cells - 5);
    }
    // Guarantee equal kit crystal count (3 each → +base = 4)
    fillTeamKitSpawns('ally', KIT_PER_TEAM - countKit('ally'));
    fillTeamKitSpawns('enemy', KIT_PER_TEAM - countKit('enemy'));
    // If one side still short (bad terrain), trim the other so counts match
    let nAlly = countKit('ally');
    let nEnemy = countKit('enemy');
    const matched = Math.min(nAlly, nEnemy, KIT_PER_TEAM);
    if (nAlly > matched) {
      for (let i = spawns.length - 1; i >= 0 && nAlly > matched; i--) {
        if (spawns[i].team === 'ally') {
          spawns.splice(i, 1);
          nAlly--;
        }
      }
    }
    if (nEnemy > matched) {
      for (let i = spawns.length - 1; i >= 0 && nEnemy > matched; i--) {
        if (spawns[i].team === 'enemy') {
          spawns.splice(i, 1);
          nEnemy--;
        }
      }
    }

    // AI pads: 4 near base + 6 on main lanes, same diagonal half as player crystals
    const aiSpawns = [];
    function aiTooClose(gx, gz, list, minDist2) {
      minDist2 = minDist2 != null ? minDist2 : 9;
      for (let i = 0; i < list.length; i++) {
        const dx = list[i]._gx - gx;
        const dz = list[i]._gz - gz;
        if (dx * dx + dz * dz < minDist2) return true;
      }
      return false;
    }
    function pushAiSpawn(team, gx, gz) {
      if (gx < 3 || gz < 3 || gx >= cells - 3 || gz >= cells - 3) return false;
      if (!isLand(gx, gz) || isWater(gx, gz)) return false;
      if (!inTeamHalf(team, gx, gz)) return false;
      if (tooNearEnemyBase(team, gx, gz)) return false;
      if (bridgeKey[gx + ',' + gz] || nearBridgeMouth(gx, gz, 1)) return false;
      if (aiTooClose(gx, gz, aiSpawns, 9)) return false;
      const cx = gx * GRID + GRID * 0.5;
      const cz = gz * GRID + GRID * 0.5;
      aiSpawns.push({
        kind: 'aiSpawn',
        team: team,
        cx: cx,
        cz: cz,
        x: cx,
        z: cz,
        w: GRID,
        d: GRID,
        ox: Math.floor(cx - GRID * 0.5),
        oz: Math.floor(cz - GRID * 0.5),
        yaw: 0,
        _gx: gx,
        _gz: gz,
      });
      return true;
    }
    function placeAiPads(team) {
      const ownBx = team === 'enemy' ? enemyBaseX : allyBaseX;
      const ownBz = team === 'enemy' ? enemyBaseZ : allyBaseZ;
      const bgx = Math.floor(ownBx / GRID);
      const bgz = Math.floor(ownBz / GRID);
      const gxShore0 = team === 'ally' ? 4 : bMin;
      const gxShore1 = team === 'ally' ? aMax : cells - 5;

      // 4 around own base — ring on center-facing side only (not behind base)
      const baseCands = [];
      for (let r = 3; r <= 7; r++) {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const gx = Math.round(bgx + Math.cos(ang) * r);
          const gz = Math.round(bgz + Math.sin(ang) * r);
          if (cellNearBase(gx, gz) && r < 5) continue;
          if (!isLand(gx, gz) || isWater(gx, gz)) continue;
          if (!inTeamHalf(team, gx, gz)) continue;
          if (behindOwnBase(team, gx, gz)) continue;
          if (tooNearEnemyBase(team, gx, gz)) continue;
          const midScore = Math.abs(diagT(gx, gz) - 1);
          baseCands.push({ gx: gx, gz: gz, midScore: midScore, r: r });
        }
      }
      baseCands.sort(function (a, b) {
        return a.midScore - b.midScore || a.r - b.r;
      });
      let baseN = 0;
      for (let i = 0; i < baseCands.length && baseN < 4; i++) {
        if (pushAiSpawn(team, baseCands[i].gx, baseCands[i].gz)) baseN++;
      }

      // 6 on main roads — mid denser (3), top/bot up to 2 each; sample along path
      let roadN = 0;
      for (let li = 0; li < spawnLanes.length && li < 3 && roadN < 6; li++) {
        const lane = spawnLanes[li];
        const laneCap = lane.id === 'mid' ? 3 : 2;
        const cands = [];
        const step = Math.max(1, Math.floor(lane.cells.length / 28));
        for (let ci = 0; ci < lane.cells.length; ci += step) {
          const pc = lane.cells[ci];
          for (let dz = -2; dz <= 2; dz++) {
            for (let dx = -2; dx <= 2; dx++) {
              const gx = pc.gx + dx;
              const gz = pc.gz + dz;
              if (gx < gxShore0 || gx > gxShore1) continue;
              if (!isLand(gx, gz) || isWater(gx, gz)) continue;
              if (cellNearBase(gx, gz)) continue;
              if (!inTeamHalf(team, gx, gz)) continue;
              if (tooNearEnemyBase(team, gx, gz)) continue;
              if (bridgeKey[gx + ',' + gz] || nearBridgeMouth(gx, gz, 1)) continue;
              if (laneDist(lane, gx, gz) > 2) continue;
              const road =
                clsAt(gx, gz) === SEM.ROAD ||
                clsAt(gx + 1, gz) === SEM.ROAD ||
                clsAt(gx - 1, gz) === SEM.ROAD ||
                clsAt(gx, gz + 1) === SEM.ROAD ||
                clsAt(gx, gz - 1) === SEM.ROAD
                  ? 0
                  : 1;
              const shoulder = laneDist(lane, gx, gz) === 0 ? 1 : 0;
              const midScore = Math.abs(diagT(gx, gz) - 1);
              cands.push({
                gx: gx,
                gz: gz,
                road: road,
                shoulder: shoulder,
                midScore: midScore,
              });
            }
          }
        }
        cands.sort(function (a, b) {
          if (a.road !== b.road) return a.road - b.road;
          if (a.midScore !== b.midScore) return a.midScore - b.midScore;
          return a.shoulder - b.shoulder;
        });
        let laneGot = 0;
        const used = {};
        for (let i = 0; i < cands.length && laneGot < laneCap && roadN < 6; i++) {
          const k = cands[i].gx + ',' + cands[i].gz;
          if (used[k]) continue;
          used[k] = true;
          if (pushAiSpawn(team, cands[i].gx, cands[i].gz)) {
            laneGot++;
            roadN++;
          }
        }
      }

      // Fill until 10 pads — also prefer mid-band
      let teamCount = 0;
      for (let i = 0; i < aiSpawns.length; i++) {
        if (aiSpawns[i].team === team) teamCount++;
      }
      if (teamCount < 10) {
        const fill = [];
        for (let gz = 3; gz < cells - 3; gz++) {
          for (let gx = gxShore0; gx <= gxShore1; gx++) {
            if (!isLand(gx, gz) || isWater(gx, gz)) continue;
            if (!inTeamHalf(team, gx, gz)) continue;
            if (tooNearEnemyBase(team, gx, gz)) continue;
            if (bridgeKey[gx + ',' + gz]) continue;
            const midScore = Math.abs(diagT(gx, gz) - 1);
            fill.push({ gx: gx, gz: gz, midScore: midScore });
          }
        }
        fill.sort(function (a, b) {
          return a.midScore - b.midScore;
        });
        for (let i = 0; i < fill.length && teamCount < 10; i++) {
          if (pushAiSpawn(team, fill[i].gx, fill[i].gz)) teamCount++;
        }
      }
    }
    placeAiPads('ally');
    placeAiPads('enemy');

    // Mid-span ziplines: each through-bridge gets 2 zips (left/right of mid deck)
    const zips = [];
    const zipBridgeKey = {};
    function groundOkForZip(gx, gz) {
      if (gx < 3 || gz < 3 || gx >= cells - 3 || gz >= cells - 3) return false;
      if (!isLand(gx, gz) || isWater(gx, gz)) return false;
      if (cellNearBase(gx, gz)) return false;
      if (bridgeKey[gx + ',' + gz]) return false;
      return true;
    }
    function findZipGround(bridgeGx, bridgeGz, dirX, dirZ) {
      // Push perpendicular from mid deck onto same-side dry land (4–6 cells ≈ 32–48 world)
      for (let dist = 4; dist <= 6; dist++) {
        const gx = clampCell(bridgeGx + Math.round(dirX * dist));
        const gz = clampCell(bridgeGz + Math.round(dirZ * dist));
        if (!groundOkForZip(gx, gz)) continue;
        // Reject if a straight step toward bridge crosses open water only (same-shore soft check)
        let waterHits = 0;
        for (let t = 1; t < dist; t++) {
          const sx = Math.round(bridgeGx + dirX * t);
          const sz = Math.round(bridgeGz + dirZ * t);
          if (isWater(sx, sz) && !bridgeKey[sx + ',' + sz]) waterHits++;
        }
        if (waterHits > 2) continue;
        return { gx: gx, gz: gz };
      }
      // Fan search around preferred ray
      for (let dist = 4; dist <= 7; dist++) {
        for (let a = -2; a <= 2; a++) {
          const ang = Math.atan2(dirZ, dirX) + a * 0.35;
          const gx = clampCell(bridgeGx + Math.round(Math.cos(ang) * dist));
          const gz = clampCell(bridgeGz + Math.round(Math.sin(ang) * dist));
          if (groundOkForZip(gx, gz)) return { gx: gx, gz: gz };
        }
      }
      return null;
    }
    for (let i = 0; i < activeLanes.length; i++) {
      const L = activeLanes[i];
      if (!L.cross || !L.cross.midCell) continue;
      const mid = L.cross.midCell;
      const bridgeGx = mid.gx;
      const bridgeGz = mid.gz;
      if (!bridgeKey[bridgeGx + ',' + bridgeGz]) continue;
      const sides = [
        { dx: perpX, dz: perpZ },
        { dx: -perpX, dz: -perpZ },
      ];
      for (let s = 0; s < sides.length; s++) {
        const gnd = findZipGround(bridgeGx, bridgeGz, sides[s].dx, sides[s].dz);
        if (!gnd) continue;
        const mountGx = bridgeGx;
        const mountGz = bridgeGz;
        const bk = mountGx + ',' + mountGz + ':' + gnd.gx + ',' + gnd.gz;
        if (zipBridgeKey[bk]) continue;
        zipBridgeKey[bk] = true;
        // stampKitZipline expects world-block gx/gz (not semantic cell index)
        const worldGx = gnd.gx * GRID + Math.floor(GRID * 0.5);
        const worldGz = gnd.gz * GRID + Math.floor(GRID * 0.5);
        zips.push({
          kind: 'zipline',
          bridgeGx: mountGx,
          bridgeGz: mountGz,
          gx: worldGx,
          gz: worldGz,
          height: 'low',
        });
      }
    }

    // Cover only at bridge piers / lane shoulders — count into nearest bucket
    const cover = [];
    const coverKey = {};
    const addCover = function (gx, gz) {
      if (gx < 3 || gz < 3 || gx >= cells - 3 || gz >= cells - 3) return;
      if (cellNearBase(gx, gz) || isWater(gx, gz)) return;
      if (bridgeKey[gx + ',' + gz]) return;
      if (nearBridgeMouth(gx, gz, 0)) return;
      const k = gx + ',' + gz;
      if (coverKey[k]) return;
      for (let b = 0; b < buildings.length; b++) {
        const dx = buildings[b]._gx - gx;
        const dz = buildings[b]._gz - gz;
        if (dx * dx + dz * dz < MIN_BUILDING_DIST2) return;
      }
      const near = nearestLaneId(gx, gz);
      const side = gx <= waterCx ? 'A' : 'B';
      const bkey = near.id + side;
      if ((perLaneSide[bkey] || 0) >= maxPerLaneSide + 2) return;
      perLaneSide[bkey] = (perLaneSide[bkey] || 0) + 1;
      coverKey[k] = true;
      cover.push({
        kind: 'ruin',
        cx: gx * GRID + GRID * 0.5,
        cz: gz * GRID + GRID * 0.5,
        yaw: (gx + gz) % 2 === 0 ? 0 : 90,
      });
    };
    for (let i = 0; i < bridgeMouths.length; i++) {
      const m = bridgeMouths[i];
      addCover(m.gx, m.gz + 2);
      addCover(m.gx, m.gz - 2);
      addCover(m.gx + (m.gx < waterCx ? -1 : 1), m.gz + 1);
    }

    const placed = [];
    if (bridgeCells.length) {
      placed.push({
        kind: 'bridgeNet',
        cells: bridgeCells,
        cellSize: GRID,
        height: 'low',
        yaw: 0,
      });
    }
    if (catCells.length >= 2) {
      placed.push({
        kind: 'bridgeNet',
        cells: catCells,
        cellSize: GRID,
        height: 'mid',
        yaw: 0,
      });
    }
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      placed.push({ kind: b.kind, cx: b.cx, cz: b.cz, yaw: b.yaw });
    }
    for (let i = 0; i < cover.length && i < 16; i++) placed.push(cover[i]);
    for (let i = 0; i < spawns.length && i < 6; i++) placed.push(spawns[i]);
    for (let i = 0; i < aiSpawns.length && i < 24; i++) {
      const a = aiSpawns[i];
      placed.push({
        kind: 'aiSpawn',
        team: a.team,
        cx: a.cx,
        cz: a.cz,
        yaw: 0,
      });
    }
    for (let i = 0; i < zips.length && i < 6; i++) placed.push(zips[i]);

    return {
      placed: placed,
      terrain: { cells: cells, data: Array.prototype.slice.call(grid) },
      stats: {
        mode: 'map',
        water: waterCells,
        walls: buildings.length,
        bridges: bridgeCells.length,
        cover: Math.min(cover.length, 16),
        spawns: Math.min(spawns.length, 6),
        aiSpawns: Math.min(aiSpawns.length, 24),
        zips: Math.min(zips.length, 6),
        lanes: activeLanes.length,
      },
    };
  }

  /**
   * Sample top-down map image → kit placed[] + terrain mask.
   * Color (高德/卫星) → HSV semantic; radar greyscale → luminance fallback.
   */
  function kitFromImageElement(img) {
    const sem = buildSemanticGrid(img);
    const result = kitFromSemanticGrid(sem.grid, sem.cells);
    if (result.stats) result.stats.mode = sem.mode;
    return result;
  }

  function syncApplyGenBtn() {
    const btn = document.getElementById('map-kit-apply-gen-btn');
    if (!btn) return;
    const ready = !!(state.genPreview && state.genPreview.placed && state.genPreview.placed.length);
    btn.classList.toggle('hidden', !ready);
    btn.disabled = !ready;
  }

  function drawTerrainOverlay(ctx, cw, ch, terrain) {
    if (!terrain || !terrain.data) return;
    const cells = terrain.cells || SEM_CELLS;
    const data = terrain.data;
    const colors = {
      1: 'rgba(42, 110, 170, 0.38)',
      2: 'rgba(200, 200, 210, 0.4)',
      3: 'rgba(70, 160, 80, 0.32)',
      4: 'rgba(220, 140, 70, 0.35)',
    };
    const cwCell = cw / cells;
    const chCell = ch / cells;
    for (let gz = 0; gz < cells; gz++) {
      for (let gx = 0; gx < cells; gx++) {
        const c = data[gz * cells + gx] | 0;
        if (!colors[c]) continue;
        ctx.fillStyle = colors[c];
        ctx.fillRect(gx * cwCell, gz * chCell, cwCell + 0.5, chCell + 0.5);
      }
    }
    ctx.fillStyle = 'rgba(255,232,212,0.85)';
    ctx.font = '11px Zpix, monospace';
    ctx.fillText('水', 8, 28);
    ctx.fillStyle = 'rgba(42,110,170,0.9)';
    ctx.fillRect(28, 18, 12, 12);
    ctx.fillStyle = 'rgba(255,232,212,0.85)';
    ctx.fillText('路', 48, 28);
    ctx.fillStyle = 'rgba(200,200,210,0.9)';
    ctx.fillRect(68, 18, 12, 12);
    ctx.fillStyle = 'rgba(255,232,212,0.85)';
    ctx.fillText('绿', 88, 28);
    ctx.fillStyle = 'rgba(70,160,80,0.9)';
    ctx.fillRect(108, 18, 12, 12);
    ctx.fillStyle = 'rgba(255,232,212,0.85)';
    ctx.fillText('建', 128, 28);
    ctx.fillStyle = 'rgba(220,140,70,0.9)';
    ctx.fillRect(148, 18, 12, 12);
  }

  function applyGeneratedPreview() {
    const prev = state.genPreview;
    if (!prev || !prev.placed || !prev.placed.length) {
      setStatus('没有待应用的生成结果 · 请先上传参考图');
      return;
    }
    if (!ensureWorldReady()) return;
    setStatus('正在写入体素地图…');
    let ok = false;
    try {
      ok = applyKitToWorld(prev.placed, {
        skipSave: false,
        terrain: prev.terrain || null,
      });
    } catch (err) {
      console.error('[VF] applyGeneratedPreview', err);
      ok = false;
    }
    if (!ok) {
      setStatus('写入失败 · 预览仍保留，可重试或换图');
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('参考图写入失败，请重试');
      }
      return;
    }
    state.genPreview = null;
    syncApplyGenBtn();
    invalidateAndRedraw();
    syncCount();
    const s = prev.stats || {};
    setStatus(
      '已应用参考图 · ' +
        (s.lanes || 0) +
        '路 · 建筑 ' +
        (s.walls || 0) +
        ' · 水域 ' +
        (s.water || 0) +
        ' · 桥格 ' +
        (s.bridges || 0) +
        ' · 可继续微调'
    );
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('参考图地图已应用到局内');
    }
  }

  function importMapImage(file) {
    if (!file) return;
    if (!ensureWorldReady()) return;
    setStatus('正在识别参考图（建筑/道路/水域）…');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      try {
        const result = kitFromImageElement(img);
        URL.revokeObjectURL(url);
        if (!result || !result.placed || !result.placed.length) {
          setStatus('未能识别可用布局 · 请用高德/卫星俯视截图');
          state.genPreview = null;
          syncApplyGenBtn();
          return;
        }
        state.genPreview = result;
        syncApplyGenBtn();
        invalidateAndRedraw();
        const s = result.stats || {};
        setStatus(
          '预览就绪（' +
            (s.mode || 'map') +
            '）· ' +
            (s.lanes || 0) +
            '路·桥 ' +
            (s.bridges || 0) +
            ' · 水 ' +
            (s.water || 0) +
            ' · 建筑 ' +
            (s.walls || 0) +
            ' · 点「应用生成」写入局内'
        );
        if (global.VF.UI && global.VF.UI.toast) {
          global.VF.UI.toast('参考图已识别 · 确认后点应用生成');
        }
      } catch (err) {
        URL.revokeObjectURL(url);
        console.error(err);
        setStatus('图片生成失败 · 请用高德/卫星俯视截图');
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      setStatus('图片读取失败');
    };
    img.src = url;
  }

  function injectStyles() {
    if (document.getElementById('map-kit-css')) return;
    const s = document.createElement('style');
    s.id = 'map-kit-css';
    s.textContent =
      '#map-kit-overlay{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(8,10,14,.82);padding:1vh 0.6rem}' +
      '#map-kit-overlay.hidden{display:none!important}' +
      '#map-kit-overlay .class-panel{max-width:min(1100px,96vw)}' +
      '#map-kit-apply-gen-btn.hidden{display:none!important}' +
      '#map-kit-canvas{width:min(68vh,640px);height:min(68vh,640px);aspect-ratio:1;display:block;' +
      'background:#0c1016;border:1px solid #2a3340;border-radius:6px;cursor:crosshair;touch-action:none;' +
      'image-rendering:pixelated}' +
      '.map-kit-palette{display:flex;flex-direction:column;gap:6px}' +
      '.map-kit-pal{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;' +
      'background:#1a1e24;border:1px solid #333;border-radius:6px;color:#e8e6e1;cursor:pointer;' +
      'font:12px system-ui,sans-serif;text-align:left}' +
      '.map-kit-pal.selected{border-color:#7ec8ff;background:#1e2a38}' +
      '.map-kit-pal-swatch{width:18px;height:18px;border-radius:3px;border:1px solid #000;flex-shrink:0}' +
      '.map-kit-hint{font-size:11px;color:#9aa4b0;margin:0}' +
      '.map-kit-count{font-size:12px;color:#c8d6e4;margin:6px 0 0}' +
      '.map-kit-heights{display:flex;gap:6px;margin:8px 0}' +
      '.map-kit-hbtn{flex:1;padding:6px 0;background:#1a1e24;border:1px solid #333;border-radius:6px;' +
      'color:#c8d6e4;cursor:pointer;font:12px system-ui,sans-serif}' +
      '.map-kit-hbtn.selected{border-color:#7ec8ff;background:#1e2a38;color:#fff}' +
      'body.map-level-editing #hud{display:none!important}' +
      '#map-fps-hud{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:11050;' +
      'display:flex;flex-wrap:wrap;gap:6px;max-width:min(960px,96vw);justify-content:center;' +
      'padding:10px 12px;background:rgba(10,12,16,.82);border:1px solid #2a3340;border-radius:10px}' +
      '#map-fps-hud.hidden{display:none!important}' +
      '#map-fps-hud button{padding:8px 10px;background:#1a1e24;border:1px solid #333;border-radius:6px;' +
      'color:#e8e6e1;cursor:pointer;font:12px system-ui,sans-serif}' +
      '#map-fps-hud button.selected{border-color:#7ec8ff;background:#1e2a38}' +
      '#map-fps-hud .map-fps-meta{width:100%;text-align:center;color:#9aa4b0;font:11px system-ui,sans-serif}';
    document.head.appendChild(s);
  }

  function setStatus(msg) {
    const elStatus = document.getElementById('map-kit-status');
    if (elStatus) elStatus.textContent = msg || '';
  }

  function countPieces() {
    let n = 0;
    for (let i = 0; i < state.placed.length; i++) {
      const p = state.placed[i];
      if (p.kind === 'bridgeNet') n += (p.cells && p.cells.length) || 0;
      else n += 1;
    }
    return n;
  }

  function syncCount() {
    if (state.countEl) {
      let aiA = 0;
      let aiE = 0;
      for (let i = 0; i < state.placed.length; i++) {
        const p = state.placed[i];
        if (p.kind !== 'aiSpawn') continue;
        if (p.team === 'enemy') aiE++;
        else aiA++;
      }
      state.countEl.textContent =
        '格子 ' +
        GRID +
        '×' +
        GRID +
        ' · 已放置 ' +
        countPieces() +
        ' 格/件 · 蓝AI ' +
        aiA +
        ' · 红AI ' +
        aiE;
    }
    if (state.yawEl) {
      const h = heightDef(state.bridgeHeight);
      state.yawEl.textContent =
        '朝向 ' +
        state.yaw +
        '°（Q/R）· 桥高 ' +
        h.label +
        ' (Y' +
        h.deckY +
        ')';
    }
    document.querySelectorAll('.map-kit-pal').forEach(function (btn) {
      btn.classList.toggle('selected', btn.getAttribute('data-prefab') === state.prefab);
    });
    document.querySelectorAll('.map-kit-hbtn').forEach(function (btn) {
      btn.classList.toggle('selected', btn.getAttribute('data-height') === state.bridgeHeight);
    });
  }

  function invalidateAndRedraw() {
    if (global.VF.UI && global.VF.UI.invalidateWorldMapCache) {
      global.VF.UI.invalidateWorldMapCache();
    }
    state.needsRedraw = true;
  }

  function canvasToWorld(clientX, clientY) {
    const canvas = state.canvas;
    const w = world();
    if (!canvas || !w) return null;
    const rect = canvas.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * canvas.width;
    const py = ((clientY - rect.top) / rect.height) * canvas.height;
    const size = w.worldSize;
    return {
      x: (px / canvas.width) * size,
      z: (py / canvas.height) * size,
      px: px,
      py: py,
    };
  }

  function collectBridgeCells() {
    const out = [];
    for (let i = 0; i < state.placed.length; i++) {
      const p = state.placed[i];
      if (p.kind !== 'bridgeNet' || !p.cells) continue;
      const h = p.height || 'low';
      for (let j = 0; j < p.cells.length; j++) {
        out.push({ gx: p.cells[j].gx, gz: p.cells[j].gz, height: h });
      }
    }
    return out;
  }

  function collectZiplines() {
    return state.placed.filter(function (p) {
      return p.kind === 'zipline';
    });
  }

  function getBridgeNet(height) {
    height = height || state.bridgeHeight;
    for (let i = 0; i < state.placed.length; i++) {
      const p = state.placed[i];
      if (p.kind === 'bridgeNet' && (p.height || 'low') === height) return p;
    }
    return null;
  }

  function bridgeCellAt(gx, gz, height) {
    if (height) {
      const net = getBridgeNet(height);
      if (!net || !net.cells) return null;
      for (let i = 0; i < net.cells.length; i++) {
        if (net.cells[i].gx === gx && net.cells[i].gz === gz) return { height: height, net: net };
      }
      return null;
    }
    for (let hi = 0; hi < HEIGHTS.length; hi++) {
      const h = HEIGHTS[hi].id;
      const hit = bridgeCellAt(gx, gz, h);
      if (hit) return hit;
    }
    return null;
  }

  function findPlacedAt(wx, wz) {
    const g = worldToGrid(wx, wz);
    // Prefer current height bridge, then any
    let hit = bridgeCellAt(g.gx, g.gz, state.bridgeHeight);
    if (!hit) hit = bridgeCellAt(g.gx, g.gz, null);
    if (hit) {
      for (let i = 0; i < state.placed.length; i++) {
        const p = state.placed[i];
        if (p.kind === 'bridgeNet' && (p.height || 'low') === hit.height) return i;
      }
    }
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < state.placed.length; i++) {
      const p = state.placed[i];
      if (p.kind === 'bridgeNet') continue;
      const cx = p.cx != null ? p.cx : p.x;
      const cz = p.cz != null ? p.cz : p.z;
      const hw = (p.w || 12) * 0.55;
      const hd = (p.d || 12) * 0.55;
      if (Math.abs(wx - cx) <= hw && Math.abs(wz - cz) <= hd) {
        const d = Math.hypot(wx - cx, wz - cz);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best;
  }

  function findZiplineAt(wx, wz) {
    const g = worldToGrid(wx, wz);
    for (let i = 0; i < state.placed.length; i++) {
      const p = state.placed[i];
      if (p.kind !== 'zipline') continue;
      if (p.bridgeGx === g.gx && p.bridgeGz === g.gz) return i;
      if (p.gx != null && Math.abs(p.gx - wx) < 4 && Math.abs(p.gz - wz) < 4) return i;
    }
    return -1;
  }

  function collectBridgeCellsFrom(placed) {
    const out = [];
    const list = placed || [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.kind !== 'bridgeNet' || !p.cells) continue;
      const h = p.height || 'low';
      for (let j = 0; j < p.cells.length; j++) {
        out.push({ gx: p.cells[j].gx, gz: p.cells[j].gz, height: h });
      }
    }
    return out;
  }

  function collectZiplinesFrom(placed) {
    return (placed || []).filter(function (p) {
      return p.kind === 'zipline';
    });
  }

  function redraw() {
    const canvas = state.canvas;
    const w = world();
    if (!canvas || !w || !global.VF.UI || !global.VF.UI.drawWorldOverview) return;
    if (state.fpsMode) return;

    const def = prefabDef(state.prefab);
    const fp = footprintFor(def, state.yaw);
    const useCell = isBridgeTool() || isZiplineTool() || isSpawnTool() || isAiSpawnTool();
    const previewing = !!(state.genPreview && state.genPreview.placed);
    const drawPlaced = previewing ? state.genPreview.placed : state.placed;
    const overlayTerrain =
      (state.genPreview && state.genPreview.terrain) || state.terrain;

    // Preview: dark base (hide default canal/buildings under overlay)
    if (previewing) {
      const ctx0 = canvas.getContext('2d');
      ctx0.fillStyle = '#0a1018';
      ctx0.fillRect(0, 0, canvas.width, canvas.height);
      if (overlayTerrain) {
        drawTerrainOverlay(ctx0, canvas.width, canvas.height, overlayTerrain);
      }
      // Draw preview pieces on top without world basemap
      global.VF.UI.drawWorldOverview(canvas, w, {
        showLandmarks: false,
        showSpawns: false,
        showGrid: GRID,
        skipBasemap: true,
        bridgeCells: collectBridgeCellsFrom(drawPlaced),
        ziplines: collectZiplinesFrom(drawPlaced),
        gridCell: GRID,
        placed: drawPlaced.filter(function (p) {
          return p.kind !== 'bridgeNet' && p.kind !== 'zipline';
        }),
        hoverIndex: -1,
        ghost: null,
      });
      const ctx = canvas.getContext('2d');
      const cw = canvas.width;
      const ch = canvas.height;
      ctx.fillStyle = 'rgba(255, 232, 212, 0.95)';
      ctx.font = '12px Zpix, monospace';
      ctx.fillText('预览（未应用）', cw / 2 - 48, 16);
      ctx.fillText('N', cw / 2 - 4, 32);
      ctx.fillText('S', cw / 2 - 4, ch - 8);
      ctx.fillText('W', 8, ch / 2 + 4);
      ctx.fillText('E', cw - 16, ch / 2 + 4);
      state.needsRedraw = false;
      return;
    }

    global.VF.UI.drawWorldOverview(canvas, w, {
      showLandmarks: true,
      showSpawns: true,
      showGrid: GRID,
      bridgeCells: collectBridgeCells(),
      ziplines: collectZiplines(),
      gridCell: GRID,
      placed: state.placed.filter(function (p) {
        return p.kind !== 'bridgeNet' && p.kind !== 'zipline';
      }),
      hoverIndex: state.hoverIndex,
      ghost: state.hover
        ? {
            cx: state.hover.x,
            cz: state.hover.z,
            w: useCell ? GRID : fp.w,
            d: useCell ? GRID : fp.d,
            yaw: useCell ? 0 : state.yaw,
            gridAlign: true,
            cell: useCell ? GRID : 0,
            bridgeHeight: isBridgeTool() ? state.bridgeHeight : null,
          }
        : null,
    });

    const ctx = canvas.getContext('2d');
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.fillStyle = 'rgba(255, 232, 212, 0.9)';
    ctx.font = '12px Zpix, monospace';
    ctx.fillText('N', cw / 2 - 4, 16);
    ctx.fillText('S', cw / 2 - 4, ch - 8);
    ctx.fillText('W', 8, ch / 2 + 4);
    ctx.fillText('E', cw - 16, ch / 2 + 4);

    if (overlayTerrain) drawTerrainOverlay(ctx, cw, ch, overlayTerrain);

    state.needsRedraw = false;
  }

  function loop() {
    state.raf = requestAnimationFrame(loop);
    if (state.fpsMode) {
      updateFpsGhost();
      return;
    }
    if (!state.open) return;
    if (state.needsRedraw) redraw();
  }

  function ensureWorldReady() {
    const g = game();
    const w = world();
    if (!g || !w) {
      setStatus('请先进入大厅，再搭建地图');
      return false;
    }
    return true;
  }

  function clearToCanvas() {
    if (!ensureWorldReady()) return;
    state.genPreview = null;
    syncApplyGenBtn();
    applyKitToWorld([], { skipSave: false, terrain: null });
    invalidateAndRedraw();
    setStatus('已清空 · 仅保留基地与默认地形');
    syncCount();
  }

  function rebuildWithBridgeEdit(height, cells) {
    const others = state.placed.filter(function (p) {
      return !(p.kind === 'bridgeNet' && (p.height || 'low') === height);
    });
    const next = others.slice();
    if (cells.length) {
      next.push({
        kind: 'bridgeNet',
        cells: cells,
        yaw: state.yaw,
        cellSize: GRID,
        height: height,
      });
    }
    applyKitToWorld(next, { skipSave: false });
  }

  function paintBridgeCell(gx, gz, erase) {
    if (!ensureWorldReady()) return;
    const height = state.bridgeHeight || 'low';
    const key = gx + ',' + gz + ',' + height + (erase ? 'e' : 'p');
    if (state.lastPaintKey === key) return;
    state.lastPaintKey = key;

    const net = getBridgeNet(height);
    let cells = net && net.cells ? net.cells.slice() : [];
    const idx = cells.findIndex(function (c) {
      return c.gx === gx && c.gz === gz;
    });

    if (erase) {
      if (idx < 0) {
        // Erase any height at this cell when RMB without matching current height
        const any = bridgeCellAt(gx, gz, null);
        if (any) {
          const n2 = getBridgeNet(any.height);
          let cells2 = n2 && n2.cells ? n2.cells.slice() : [];
          const i2 = cells2.findIndex(function (c) {
            return c.gx === gx && c.gz === gz;
          });
          if (i2 >= 0) {
            cells2.splice(i2, 1);
            rebuildWithBridgeEdit(any.height, cells2);
            invalidateAndRedraw();
            syncCount();
            setStatus('已擦除桥格 ' + gx + ',' + gz + ' · ' + heightDef(any.height).label);
          }
        }
        return;
      }
      cells.splice(idx, 1);
    } else {
      if (idx >= 0) return;
      cells.push({ gx: gx, gz: gz });
    }

    rebuildWithBridgeEdit(height, cells);
    invalidateAndRedraw();
    syncCount();
    setStatus(
      erase
        ? '已擦除桥格 ' + gx + ',' + gz
        : '已画桥格 ' + gx + ',' + gz + ' · ' + heightDef(height).label + ' · 相邻连通 · 可跨河'
    );
  }

  function placeZiplineAt(wx, wz) {
    if (!ensureWorldReady()) return;
    const w = world();
    const g = worldToGrid(wx, wz);
    const hit = bridgeCellAt(g.gx, g.gz, null);
    if (!hit) {
      setStatus('滑索只能挂在桥格上，不能放在房子上');
      return;
    }
    if (w && w.findKitZiplineGround && !w.findKitZiplineGround(g.gx, g.gz, GRID)) {
      setStatus('滑索放置失败：附近没有空地（避开房子/水面）');
      return;
    }
    // Replace existing zip to same bridge cell
    const next = state.placed.filter(function (p) {
      if (p.kind !== 'zipline') return true;
      return !(p.bridgeGx === g.gx && p.bridgeGz === g.gz && (p.height || 'low') === hit.height);
    });
    next.push({
      kind: 'zipline',
      bridgeGx: g.gx,
      bridgeGz: g.gz,
      height: hit.height,
    });
    applyKitToWorld(next, { skipSave: false });
    invalidateAndRedraw();
    syncCount();
    setStatus(
      '已放置滑索 → 桥格 ' + g.gx + ',' + g.gz + ' · ' + heightDef(hit.height).label + ' · 挂在桥边'
    );
  }

  function placeBuildingAt(wx, wz) {
    const w = world();
    const g = game();
    if (!ensureWorldReady()) return;
    if (!w._editorCanvas || !g._mapKitLayout) {
      applyKitToWorld(state.placed.slice(), { skipSave: true });
    }
    const snap = snapWorld(wx, wz);
    const stamped = w.stampEditorPrefab(state.prefab, snap.x, snap.z, state.yaw);
    if (!stamped) {
      setStatus('放置失败（可能在水上、基地范围或越界）');
      return;
    }
    state.placed.push(stamped);
    if (w.ensureMeshedAround) w.ensureMeshedAround(snap.x, snap.z, 6);
    writeStoredKit(true);
    invalidateAndRedraw();
    syncCount();
    setStatus(
      '已放置 ' + prefabDef(state.prefab).label + ' @ 格 ' + snap.gx + ',' + snap.gz + ' · 朝向 ' + state.yaw + '°'
    );
  }

  function deleteAt(wx, wz) {
    if (!ensureWorldReady()) return;
    const gcell = worldToGrid(wx, wz);

    const zipIdx = findZiplineAt(wx, wz);
    if (zipIdx >= 0) {
      const next = state.placed.slice();
      next.splice(zipIdx, 1);
      applyKitToWorld(next, { skipSave: false });
      invalidateAndRedraw();
      syncCount();
      setStatus('已删除滑索');
      return;
    }

    if (bridgeCellAt(gcell.gx, gcell.gz, state.bridgeHeight) || bridgeCellAt(gcell.gx, gcell.gz, null)) {
      paintBridgeCell(gcell.gx, gcell.gz, true);
      return;
    }

    const idx = findPlacedAt(wx, wz);
    if (idx < 0) {
      setStatus('此处没有可删除的摆件');
      return;
    }
    const next = state.placed.slice();
    const removed = next.splice(idx, 1)[0];
    applyKitToWorld(next, { skipSave: false });
    invalidateAndRedraw();
    syncCount();
    setStatus('已删除 · ' + (prefabDef(removed.kind).label || removed.kind));
  }

  function handlePlaceAt(wx, wz) {
    if (isSpawnTool() || isAiSpawnTool()) {
      const snap = snapWorld(wx, wz);
      placeIncremental(snap.x, snap.z);
      invalidateAndRedraw();
      syncCount();
      setStatus(isAiSpawnTool() ? '已放置AI刷新点' : '已放置出生水晶');
      return;
    }
    if (isZiplineTool()) placeZiplineAt(wx, wz);
    else if (isBridgeTool()) {
      const snap = snapWorld(wx, wz);
      paintBridgeCell(snap.gx, snap.gz, false);
    } else placeBuildingAt(wx, wz);
  }

  function exportKit() {
    const data = {
      v: 5,
      mode: 'kit',
      grid: GRID,
      seed: (game() && game().mapSeed) || (world() && world().mapSeed) || 0,
      placed: state.placed.map(serializePlaced),
    };
    if (state.terrain && state.terrain.data) {
      data.terrain = {
        cells: state.terrain.cells || 40,
        data: Array.prototype.slice.call(state.terrain.data),
      };
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vf-map-kit.json';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('已导出摆件布局' + (data.terrain ? '（含地形）' : ''));
  }

  function importKit(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const data = JSON.parse(String(reader.result || '{}'));
        state.genPreview = null;
        syncApplyGenBtn();
        const terrain = data.terrain && data.terrain.data ? data.terrain : null;
        applyKitToWorld(data.placed || [], { skipSave: false, terrain: terrain });
        invalidateAndRedraw();
        syncCount();
        setStatus('已导入并应用到局内 · ' + countPieces() + ' 格/件');
      } catch (err) {
        setStatus('导入失败');
      }
    };
    reader.readAsText(file);
  }

  function finishAndPlay() {
    writeStoredKit(true);
    exitFpsMode(false);
    close();
    const g = game();
    if (g && g.ai && g.ai.applyPlayerTeam) g.ai.applyPlayerTeam();
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('自定义地图已保存 · 开下一局也会使用');
    }
  }

  function returnAfterClose() {
    if (!state.fromLobby) return;
    state.fromLobby = false;
    if (global.VF.Lobby && global.VF.Lobby.openLobby) {
      global.VF.Lobby.openLobby();
    }
  }
  /* --- First-person editor: no HUD, stone hands, ghost then confirm --- */

  function setLevelEditChrome(on) {
    document.body.classList.toggle('map-level-editing', !!on);
    const hud = document.getElementById('hud');
    if (hud) {
      if (on) {
        state._hudWasHidden = hud.classList.contains('hidden');
        hud.classList.add('hidden');
      } else if (state._hudWasHidden === false) {
        hud.classList.remove('hidden');
      }
    }
    if (on) {
      ensureFpsHud();
      if (state._fpsHud) state._fpsHud.classList.remove('hidden');
      syncFpsHud();
    } else if (state._fpsHud) {
      state._fpsHud.classList.add('hidden');
    }
  }

  function ensureFpsHud() {
    if (state._fpsHud) return state._fpsHud;
    injectStyles();
    const hud = el('div', 'hidden');
    hud.id = 'map-fps-hud';
    const meta = el(
      'div',
      'map-fps-meta',
      '局内编辑 · 选建筑 · 幽灵预选再点放置 · Q/R 旋转 · [ ] 桥高 · Esc 返回'
    );
    hud.appendChild(meta);
    PREFABS.forEach(function (p) {
      const b = el('button', '', p.label);
      b.type = 'button';
      b.setAttribute('data-prefab', p.id);
      b.addEventListener('click', function () {
        state.prefab = p.id;
        state._ghostLocked = null;
        ensureGhost();
        syncFpsHud();
      });
      hud.appendChild(b);
    });
    HEIGHTS.forEach(function (h) {
      const b = el('button', '', '桥' + h.label);
      b.type = 'button';
      b.setAttribute('data-height', h.id);
      b.addEventListener('click', function () {
        state.bridgeHeight = h.id;
        state.prefab = 'bridge';
        state._ghostLocked = null;
        ensureGhost();
        syncFpsHud();
      });
      hud.appendChild(b);
    });
    document.body.appendChild(hud);
    state._fpsHud = hud;
    return hud;
  }

  function syncFpsHud() {
    if (!state._fpsHud) return;
    state._fpsHud.querySelectorAll('button[data-prefab]').forEach(function (btn) {
      btn.classList.toggle('selected', btn.getAttribute('data-prefab') === state.prefab);
    });
    state._fpsHud.querySelectorAll('button[data-height]').forEach(function (btn) {
      btn.classList.toggle(
        'selected',
        state.prefab === 'bridge' && btn.getAttribute('data-height') === state.bridgeHeight
      );
    });
  }

  function disposeGhost() {
    const g = game();
    if (!state._ghost) return;
    if (g && g.scene) g.scene.remove(state._ghost);
    state._ghost.traverse(function (c) {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material))
          c.material.forEach(function (m) {
            if (m.dispose) m.dispose();
          });
        else if (c.material.dispose) c.material.dispose();
      }
    });
    state._ghost = null;
    state._ghostLocked = null;
    state._ghostKey = '';
  }

  function ghostFootprint() {
    if (isBridgeTool() || isZiplineTool() || isSpawnTool() || isAiSpawnTool()) {
      return { w: GRID, d: GRID, y: heightDef(state.bridgeHeight).deckY };
    }
    const fp = footprintFor(prefabDef(state.prefab), state.yaw);
    return { w: fp.w, d: fp.d, y: 0 };
  }

  function rebuildGhostMesh() {
    const g = game();
    if (!g || !g.scene || !global.THREE) return;
    disposeGhost();
    const fp = ghostFootprint();
    const mat = new THREE.MeshBasicMaterial({
      color: isSpawnTool()
        ? prefabDef(state.prefab).spawn === 'enemy'
          ? 0xff3344
          : 0x33aaff
        : isAiSpawnTool()
          ? prefabDef(state.prefab).aiSpawn === 'enemy'
            ? 0xff8844
            : 0x44d0c8
          : isZiplineTool()
            ? 0x9ab8d0
            : isBridgeTool()
              ? 0x6a7a88
              : 0x9a968e,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    const edge = new THREE.MeshBasicMaterial({
      color: 0x7ec8ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      wireframe: true,
    });
    const h =
      isBridgeTool() || isSpawnTool() || isAiSpawnTool()
        ? 0.9
        : Math.max(2, Math.min(12, (fp.w + fp.d) * 0.18));
    const box = new THREE.Mesh(new THREE.BoxGeometry(fp.w * 0.98, h, fp.d * 0.98), mat);
    const wire = new THREE.Mesh(new THREE.BoxGeometry(fp.w, h, fp.d), edge);
    const root = new THREE.Group();
    root.name = 'MapKitGhost';
    box.position.y = h * 0.5;
    wire.position.y = h * 0.5;
    root.add(box);
    root.add(wire);
    root.visible = false;
    g.scene.add(root);
    state._ghost = root;
    state._ghostKey = state.prefab + ':' + state.yaw + ':' + state.bridgeHeight;
  }

  function ensureGhost() {
    const key = state.prefab + ':' + state.yaw + ':' + state.bridgeHeight;
    if (!state._ghost || state._ghostKey !== key) rebuildGhostMesh();
  }

  function aimWorldPos() {
    const g = game();
    if (!g || !g.player || !g.player.camera) return null;
    const cam = g.player.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const origin = cam.getWorldPosition(new THREE.Vector3());
    let t;
    if (Math.abs(dir.y) > 0.05) {
      const sx = Math.floor(origin.x);
      const sz = Math.floor(origin.z);
      const gy = g.world && g.world._surface ? g.world._surface(sx, sz) : origin.y - 1.6;
      t = (gy + 0.5 - origin.y) / dir.y;
      if (t < 2) t = 6;
      if (t > 40) t = 40;
    } else {
      t = 10;
    }
    const hit = origin.clone().addScaledVector(dir, t);
    return { x: hit.x, z: hit.z };
  }

  function ghostGroundY(wx, wz) {
    const w = world();
    if (!w) return 4;
    if (isBridgeTool()) return heightDef(state.bridgeHeight).deckY;
    if (isZiplineTool()) {
      const hit = bridgeCellAt(Math.floor(wx / GRID), Math.floor(wz / GRID), null);
      return hit ? heightDef(hit.height).deckY : 4;
    }
    if (isSpawnTool() || isAiSpawnTool()) {
      const gy = w._surface ? w._surface(Math.floor(wx), Math.floor(wz)) : 4;
      return gy + 1;
    }
    const gy = w._surface ? w._surface(Math.floor(wx), Math.floor(wz)) : 4;
    return gy + 1;
  }

  function updateFpsGhost() {
    if (!state.fpsMode) return;
    ensureGhost();
    if (!state._ghost) return;
    let snap;
    if (state._ghostLocked) {
      snap = state._ghostLocked;
    } else {
      const pos = aimWorldPos();
      if (!pos) {
        state._ghost.visible = false;
        return;
      }
      snap = snapWorld(pos.x, pos.z);
      snap.y = ghostGroundY(snap.x, snap.z);
    }
    // Zipline ghost only valid on bridge cells (never on houses)
    if (isZiplineTool() && !state._ghostLocked) {
      const hit = bridgeCellAt(snap.gx, snap.gz, null);
      if (!hit) {
        state._ghost.visible = false;
        return;
      }
    }
    state._ghost.visible = true;
    state._ghost.position.set(snap.x, snap.y, snap.z);
    const locked = !!state._ghostLocked;
    state._ghost.traverse(function (c) {
      if (!c.material || c.material.wireframe) return;
      c.material.opacity = locked ? 0.62 : 0.38;
      c.material.color.setHex(locked ? 0x7ec8ff : isBridgeTool() ? 0x6a7a88 : 0x9a968e);
    });
  }

  function placeIncremental(wx, wz) {
    const w = world();
    const g = game();
    if (!ensureWorldReady() || !w) return;
    const snap = snapWorld(wx, wz);

    if (isSpawnTool()) {
      const team = prefabDef(state.prefab).spawn === 'enemy' ? 'enemy' : 'ally';
      let teamSpawns = state.placed.filter(function (p) {
        return p.kind === 'spawn' && (p.team || 'ally') === team;
      });
      // Max 3 kit crystals per team (fixed spawn #1 is auto at cores → total 4)
      if (teamSpawns.length >= 3) {
        const drop = teamSpawns[0];
        state.placed = state.placed.filter(function (p) {
          return p !== drop;
        });
      }
      const entry = {
        kind: 'spawn',
        team: team,
        cx: snap.x,
        cz: snap.z,
        x: snap.x,
        z: snap.z,
        w: GRID,
        d: GRID,
        ox: Math.floor(snap.x - GRID * 0.5),
        oz: Math.floor(snap.z - GRID * 0.5),
        yaw: 0,
      };
      state.placed.push(entry);
      const allSpawns = state.placed.filter(function (p) {
        return p.kind === 'spawn';
      });
      if (g.bases && g.bases.applyKitSpawns) g.bases.applyKitSpawns(allSpawns);
      writeStoredKit(true);
      return;
    }

    if (isAiSpawnTool()) {
      const team = prefabDef(state.prefab).aiSpawn === 'enemy' ? 'enemy' : 'ally';
      const entry = {
        kind: 'aiSpawn',
        team: team,
        cx: snap.x,
        cz: snap.z,
        x: snap.x,
        z: snap.z,
        w: GRID,
        d: GRID,
        ox: Math.floor(snap.x - GRID * 0.5),
        oz: Math.floor(snap.z - GRID * 0.5),
        yaw: 0,
      };
      state.placed.push(entry);
      const aiAlly = [];
      const aiEnemy = [];
      for (let i = 0; i < state.placed.length; i++) {
        const p = state.placed[i];
        if (p.kind !== 'aiSpawn') continue;
        const e = { x: p.cx, z: p.cz, cx: p.cx, cz: p.cz };
        if (p.team === 'enemy') aiEnemy.push(e);
        else aiAlly.push(e);
      }
      if (w) w._aiSpawns = { ally: aiAlly, enemy: aiEnemy };
      if (g) g._mapKitAiSpawns = { ally: aiAlly.slice(), enemy: aiEnemy.slice() };
      writeStoredKit(true);
      setStatus(
        '已放置' +
          (team === 'enemy' ? '红' : '蓝') +
          '方AI刷新点 · 蓝 ' +
          aiAlly.length +
          ' · 红 ' +
          aiEnemy.length
      );
      return;
    }

    if (isZiplineTool()) {
      const hit = bridgeCellAt(snap.gx, snap.gz, null);
      if (!hit || !w.stampKitZipline) {
        setStatus('滑索只能挂在桥格上，不能放在房子上');
        return;
      }
      if (w.findKitZiplineGround && !w.findKitZiplineGround(snap.gx, snap.gz, GRID)) {
        setStatus('滑索放置失败：附近没有空地（避开房子/水面）');
        return;
      }
      const next = state.placed.filter(function (p) {
        if (p.kind !== 'zipline') return true;
        return !(
          p.bridgeGx === snap.gx &&
          p.bridgeGz === snap.gz &&
          (p.height || 'low') === hit.height
        );
      });
      const stamped = w.stampKitZipline({
        bridgeGx: snap.gx,
        bridgeGz: snap.gz,
        height: hit.height,
        cellSize: GRID,
      });
      if (!stamped) {
        setStatus('滑索放置失败：附近没有空地（避开房子/水面）');
        return;
      }
      next.push(stamped);
      state.placed = next;
      writeStoredKit(true);
      setStatus('已放置滑索 · 挂在桥边外侧');
      return;
    }

    if (isBridgeTool()) {
      const height = state.bridgeHeight || 'low';
      if (bridgeCellAt(snap.gx, snap.gz, height)) return;
      const net = getBridgeNet(height);
      const cells = net && net.cells ? net.cells.slice() : [];
      cells.push({ gx: snap.gx, gz: snap.gz });
      if (w.stampBridgeNetwork) {
        w.stampBridgeNetwork([{ gx: snap.gx, gz: snap.gz }], GRID, state.yaw, height);
      }
      const others = state.placed.filter(function (p) {
        return !(p.kind === 'bridgeNet' && (p.height || 'low') === height);
      });
      others.push({
        kind: 'bridgeNet',
        cells: cells,
        yaw: state.yaw,
        cellSize: GRID,
        height: height,
      });
      state.placed = others;
      writeStoredKit(true);
      if (w.ensureMeshedAround) w.ensureMeshedAround(snap.x, snap.z, 4);
      return;
    }

    const stamped = w.stampEditorPrefab(state.prefab, snap.x, snap.z, state.yaw);
    if (!stamped) return;
    state.placed.push(stamped);
    if (w.ensureMeshedAround) w.ensureMeshedAround(snap.x, snap.z, 5);
    writeStoredKit(true);
  }

  function deleteIncremental(wx, wz) {
    const w = world();
    if (!ensureWorldReady() || !w) return;
    const gcell = worldToGrid(wx, wz);

    const zipIdx = findZiplineAt(wx, wz);
    if (zipIdx >= 0) {
      state.placed.splice(zipIdx, 1);
      applyKitToWorld(state.placed.slice(), { skipSave: false });
      return;
    }

    const hit =
      bridgeCellAt(gcell.gx, gcell.gz, state.bridgeHeight) || bridgeCellAt(gcell.gx, gcell.gz, null);
    if (hit) {
      const height = hit.height;
      const net = getBridgeNet(height);
      let cells = net && net.cells ? net.cells.slice() : [];
      cells = cells.filter(function (c) {
        return !(c.gx === gcell.gx && c.gz === gcell.gz);
      });
      const ox = gcell.gx * GRID;
      const oz = gcell.gz * GRID;
      const deckY = heightDef(height).deckY;
      const AIR = (global.VF && global.VF.BLOCK && global.VF.BLOCK.AIR) || 0;
      for (let x = ox; x < ox + GRID; x++) {
        for (let z = oz; z < oz + GRID; z++) {
          if (w.get(x, deckY, z)) w.set(x, deckY, z, AIR);
          if (w.get(x, deckY + 1, z)) w.set(x, deckY + 1, z, AIR);
        }
      }
      if (w.dirtyRect) w.dirtyRect(ox - 1, oz - 1, ox + GRID + 1, oz + GRID + 1);
      if (w.flushRebuilds) w.flushRebuilds(32, ox + GRID * 0.5, oz + GRID * 0.5);
      const others = state.placed.filter(function (p) {
        return !(p.kind === 'bridgeNet' && (p.height || 'low') === height);
      });
      if (cells.length) {
        others.push({
          kind: 'bridgeNet',
          cells: cells,
          yaw: state.yaw,
          cellSize: GRID,
          height: height,
        });
      }
      state.placed = others;
      writeStoredKit(true);
      return;
    }

    const idx = findPlacedAt(wx, wz);
    if (idx < 0) return;
    const p = state.placed[idx];
    if (p.kind === 'bridgeNet' || p.kind === 'zipline') return;
    if (p.kind === 'spawn') {
      state.placed.splice(idx, 1);
      const allSpawns = state.placed.filter(function (x) {
        return x.kind === 'spawn';
      });
      const g = game();
      if (g && g.bases && g.bases.applyKitSpawns) g.bases.applyKitSpawns(allSpawns);
      writeStoredKit(true);
      return;
    }
    if (p.kind === 'aiSpawn') {
      state.placed.splice(idx, 1);
      const aiAlly = [];
      const aiEnemy = [];
      for (let i = 0; i < state.placed.length; i++) {
        const x = state.placed[i];
        if (x.kind !== 'aiSpawn') continue;
        const e = { x: x.cx, z: x.cz, cx: x.cx, cz: x.cz };
        if (x.team === 'enemy') aiEnemy.push(e);
        else aiAlly.push(e);
      }
      if (w) w._aiSpawns = { ally: aiAlly, enemy: aiEnemy };
      const g = game();
      if (g) g._mapKitAiSpawns = { ally: aiAlly.slice(), enemy: aiEnemy.slice() };
      writeStoredKit(true);
      return;
    }
    if (w.clearFootprintAboveGround && p.ox != null) {
      w.clearFootprintAboveGround(p.ox, p.oz, p.w || 12, p.d || 12);
    }
    state.placed.splice(idx, 1);
    writeStoredKit(true);
  }

  function onFpsPrimaryClick() {
    const pos = aimWorldPos();
    if (!pos) return;
    const snap = snapWorld(pos.x, pos.z);
    snap.y = ghostGroundY(snap.x, snap.z);
    if (!state._ghostLocked) {
      state._ghostLocked = snap;
      updateFpsGhost();
      return;
    }
    placeIncremental(state._ghostLocked.x, state._ghostLocked.z);
    state._ghostLocked = null;
    updateFpsGhost();
  }

  function bindFpsInput() {
    if (state._fpsBound) return;
    state._fpsBound = true;
    document.addEventListener('mousedown', function (e) {
      if (!state.fpsMode) return;
      if (e.target && e.target.closest && e.target.closest('#map-fps-hud')) return;
      if (e.button === 2) {
        e.preventDefault();
        if (state._ghostLocked) {
          state._ghostLocked = null;
          updateFpsGhost();
          return;
        }
        const pos = aimWorldPos();
        if (pos) deleteIncremental(pos.x, pos.z);
        return;
      }
      if (e.button === 0) onFpsPrimaryClick();
    });
    document.addEventListener('contextmenu', function (e) {
      if (state.fpsMode) e.preventDefault();
    });
  }

  function enterFpsMode() {
    if (!ensureWorldReady()) return;
    const g = game();
    injectStyles();
    bindFpsInput();

    const overlay = document.getElementById('map-kit-overlay');
    if (overlay) overlay.classList.add('hidden');
    state.open = false;
    state.fpsMode = true;
    state._ghostLocked = null;
    g.levelEditing = true;
    g.running = true;

    if (global.VF.Lobby && global.VF.Lobby.hide) global.VF.Lobby.hide();
    if (global.VF.Hub && global.VF.Hub.hide) global.VF.Hub.hide();
    const cover = document.getElementById('start-overlay');
    if (cover) cover.classList.add('hidden');

    setLevelEditChrome(true);

    if (g.player) {
      if (g.player.applySelectedSpawn) g.player.applySelectedSpawn();
      g.player.dead = false;
      g.player.alive = true;
      g.player.health = g.player.maxHealth || 100;
      if (g.player.setHeldMode) g.player.setHeldMode('build');
    }
    if (g.weapons) {
      if (g.weapons._cancelReload) g.weapons._cancelReload();
      g.weapons.mode = 'build';
      g.weapons.firing = false;
    }
    if (g.building && g.building.exitMode) g.building.exitMode();

    ensureGhost();
    if (!state.raf) state.raf = requestAnimationFrame(loop);
    const canvas = g.renderer && g.renderer.domElement;
    if (canvas && canvas.requestPointerLock) {
      try {
        canvas.requestPointerLock();
      } catch (_) {}
    }
  }

  function exitFpsMode(reopenTopdown) {
    const g = game();
    state.fpsMode = false;
    state.painting = false;
    state._ghostLocked = null;
    disposeGhost();
    setLevelEditChrome(false);
    if (g) {
      g.levelEditing = false;
      g.running = false;
      if (g.player && g.player.setHeldMode) g.player.setHeldMode('weapon');
      if (g.weapons) g.weapons.mode = 'weapon';
    }
    document.exitPointerLock && document.exitPointerLock();
    applyKitToWorld(state.placed.slice(), { skipSave: false });
    if (reopenTopdown) open();
  }

  function buildOverlayIfNeeded() {
    if (document.getElementById('map-kit-overlay')) return;
    const overlay = el('div', 'hidden');
    overlay.id = 'map-kit-overlay';
    overlay.innerHTML =
      '<div class="class-panel">' +
      '<header class="class-header">' +
      '<p class="class-kicker">大厅 · 地图</p>' +
      '<h2 class="class-title">格子地图搭建</h2>' +
      '<p class="class-sub">默认地图 · 上传高德/卫星参考图生成 · 预览后应用 · 可继续微调</p>' +
      '</header>' +
      '<div class="class-body">' +
      '<div class="class-stage tower-stage">' +
      '<canvas id="map-kit-canvas" width="512" height="512"></canvas>' +
      '</div>' +
      '<div class="class-list tower-tools">' +
      '<section class="tower-section"><h3 class="tower-tools-title">摆件</h3>' +
      '<div class="map-kit-palette" id="map-kit-palette"></div></section>' +
      '<section class="tower-section"><h3 class="tower-tools-title">桥高度</h3>' +
      '<div class="map-kit-heights" id="map-kit-heights"></div></section>' +
      '<section class="tower-section"><p class="map-kit-count" id="map-kit-count">已放置 0</p>' +
      '<p class="map-kit-hint" id="map-kit-yaw">朝向 0°</p>' +
      '<p class="map-kit-hint" id="map-kit-status">左键放置/画桥 · 右键删除</p></section>' +
      '<section class="tower-section tower-section-actions">' +
      '<button type="button" class="class-card tower-tool-btn" id="map-kit-dust2-btn"><span class="class-card-name">载入默认地图</span></button>' +
      '<label class="class-card tower-tool-btn" id="map-kit-image-label"><span class="class-card-name">上传参考图生成地图</span>' +
      '<input id="map-kit-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden /></label>' +
      '<button type="button" class="class-card tower-tool-btn hidden" id="map-kit-apply-gen-btn"><span class="class-card-name">应用生成到局内</span></button>' +
      '<button type="button" class="class-card tower-tool-btn" id="map-kit-fps-btn"><span class="class-card-name">进入局内编辑</span></button>' +
      '<button type="button" class="class-card tower-tool-btn" id="map-kit-clear-btn"><span class="class-card-name">再次清空</span></button>' +
      '<button type="button" class="class-card tower-tool-btn" id="map-kit-export-btn"><span class="class-card-name">导出布局</span></button>' +
      '<label class="class-card tower-tool-btn" id="map-kit-import-label"><span class="class-card-name">导入布局</span>' +
      '<input id="map-kit-import" type="file" accept="application/json,.json" hidden /></label>' +
      '</section></div></div>' +
      '<div class="class-actions">' +
      '<button type="button" class="cover-btn" id="map-kit-back-btn">返回</button>' +
      '<button type="button" class="cover-btn cover-btn-start" id="map-kit-done-btn">' +
      '<span class="cover-btn-icon play" aria-hidden="true"></span><span>完成搭建</span></button>' +
      '</div></div>';
    document.body.appendChild(overlay);

    const pal = document.getElementById('map-kit-palette');
    PREFABS.forEach(function (p) {
      const btn = el('button', 'map-kit-pal', '');
      btn.type = 'button';
      btn.setAttribute('data-prefab', p.id);
      const sw = el('span', 'map-kit-pal-swatch');
      sw.style.background = p.color;
      btn.appendChild(sw);
      const suffix = p.zipline ? '' : p.paint ? '' : '（可旋转）';
      btn.appendChild(document.createTextNode(p.label + suffix));
      btn.addEventListener('click', function () {
        state.prefab = p.id;
        syncCount();
        state.needsRedraw = true;
        if (p.zipline) setStatus('滑索：只能点桥格 · 挂在桥边 · 不下房子');
        else if (p.paint) setStatus('桥梁：拖画格子 · 高度可切换');
        else if (p.spawn) setStatus('出生水晶：可占领点（蓝2/3·红2/3）；点1是大本营不可占领');
        else setStatus('左键放置 · Q/R 旋转');
      });
      pal.appendChild(btn);
    });

    const heights = document.getElementById('map-kit-heights');
    HEIGHTS.forEach(function (h) {
      const btn = el('button', 'map-kit-hbtn', h.label + ' Y' + h.deckY);
      btn.type = 'button';
      btn.setAttribute('data-height', h.id);
      btn.addEventListener('click', function () {
        state.bridgeHeight = h.id;
        state.prefab = 'bridge';
        syncCount();
        state.needsRedraw = true;
        setStatus('桥高度 · ' + h.label + ' · 拖画格子，同格可叠不同高度');
      });
      heights.appendChild(btn);
    });

    state.countEl = document.getElementById('map-kit-count');
    state.yawEl = document.getElementById('map-kit-yaw');
    state.canvas = document.getElementById('map-kit-canvas');

    document.getElementById('map-kit-dust2-btn').addEventListener('click', loadDust2Default);
    document.getElementById('map-kit-image').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      if (f) importMapImage(f);
      e.target.value = '';
    });
    document.getElementById('map-kit-image-label').addEventListener('click', function () {
      document.getElementById('map-kit-image').click();
    });
    document.getElementById('map-kit-apply-gen-btn').addEventListener('click', applyGeneratedPreview);
    document.getElementById('map-kit-fps-btn').addEventListener('click', enterFpsMode);
    document.getElementById('map-kit-clear-btn').addEventListener('click', clearToCanvas);
    document.getElementById('map-kit-export-btn').addEventListener('click', exportKit);
    document.getElementById('map-kit-import').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      if (f) importKit(f);
      e.target.value = '';
    });
    document.getElementById('map-kit-import-label').addEventListener('click', function () {
      document.getElementById('map-kit-import').click();
    });
    document.getElementById('map-kit-back-btn').addEventListener('click', function () {
      close();
    });
    document.getElementById('map-kit-done-btn').addEventListener('click', finishAndPlay);

    bindCanvas();
  }

  function bindCanvas() {
    const canvas = document.getElementById('map-kit-canvas');
    if (!canvas || canvas._mapKitBound) return;
    canvas._mapKitBound = true;

    canvas.addEventListener('pointermove', function (e) {
      const pos = canvasToWorld(e.clientX, e.clientY);
      if (!pos) return;
      const snap = snapWorld(pos.x, pos.z);
      state.hover = { x: snap.x, z: snap.z };
      state.hoverGx = snap.gx;
      state.hoverGz = snap.gz;
      state.hoverIndex = findPlacedAt(pos.x, pos.z);
      state.needsRedraw = true;

      if (state.painting && isBridgeTool()) {
        paintBridgeCell(snap.gx, snap.gz, state.paintErase);
      } else if (state.painting && state.paintErase && !isBridgeTool()) {
        deleteAt(pos.x, pos.z);
      }
    });
    canvas.addEventListener('pointerleave', function () {
      state.hover = null;
      state.hoverIndex = -1;
      state.painting = false;
      state.lastPaintKey = '';
      state.needsRedraw = true;
    });
    canvas.addEventListener('pointerdown', function (e) {
      const pos = canvasToWorld(e.clientX, e.clientY);
      if (!pos) return;
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      const snap = snapWorld(pos.x, pos.z);
      if (e.button === 2) {
        e.preventDefault();
        state.painting = true;
        state.paintErase = true;
        state.lastPaintKey = '';
        deleteAt(pos.x, pos.z);
        return;
      }
      if (e.button === 0) {
        state.painting = true;
        state.paintErase = false;
        state.lastPaintKey = '';
        handlePlaceAt(pos.x, pos.z);
      }
    });
    canvas.addEventListener('pointerup', function () {
      state.painting = false;
      state.lastPaintKey = '';
    });
    canvas.addEventListener('pointercancel', function () {
      state.painting = false;
      state.lastPaintKey = '';
    });
    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });
  }

  function open(opts) {
    opts = opts || {};
    injectStyles();
    buildOverlayIfNeeded();
    const overlay = document.getElementById('map-kit-overlay');
    if (!overlay) return;
    if (global.VF.DevTools && global.VF.DevTools.setFeelOpen) {
      global.VF.DevTools.setFeelOpen(false);
    }
    state.fromLobby = !!opts.fromLobby;
    const g = game();
    if (g) {
      state._wasRunning = !!g.running;
      g.running = false;
      g.levelEditing = false;
    }
    document.exitPointerLock && document.exitPointerLock();

    overlay.classList.remove('hidden');
    state.open = true;
    state.fpsMode = false;
    if (state._fpsHud) state._fpsHud.classList.add('hidden');
    state.canvas = document.getElementById('map-kit-canvas');
    syncCount();

    if (ensureWorldReady()) {
      const stored = readStoredKit();
      if (stored && stored.active && stored.placed && stored.placed.length) {
        const terrain =
          stored.terrain && stored.terrain.data ? stored.terrain : null;
        applyKitToWorld(stored.placed || [], {
          skipSave: false,
          terrain: terrain,
        });
        setStatus(
          terrain
            ? '已加载自定义地图（含参考图地形）· 可继续微调'
            : '已加载自定义地图 · 桥可跨河 · 低/中/高可重叠 · 滑索点桥格'
        );
      } else {
        const def = getDefaultKitPlaced();
        if (def && def.length) {
          applyKitToWorld(def, { skipSave: true, terrain: null });
          setStatus('默认地图 · 可编辑 ·「载入默认地图」可重置');
        } else {
          applyKitToWorld([], { skipSave: false, terrain: null });
          setStatus('空白格子地图 · 选摆件或点「进入局内编辑」');
        }
      }
    }
    syncApplyGenBtn();
    state.needsRedraw = true;
    if (!state.raf) state.raf = requestAnimationFrame(loop);
  }

  function close(opts) {
    opts = opts || {};
    if (state.fpsMode) exitFpsMode(false);
    const overlay = document.getElementById('map-kit-overlay');
    if (overlay) overlay.classList.add('hidden');
    state.open = false;
    state.hover = null;
    state.painting = false;
    if (!opts.skipLobby) returnAfterClose();
    else state.fromLobby = false;
  }

  function toggle() {
    if (state.fpsMode) {
      exitFpsMode(true);
      return;
    }
    if (state.open) close();
    else open();
  }

  function mount() {
    injectStyles();
    document.addEventListener('keydown', function (e) {
      if (state.fpsMode) {
        if (e.code === 'KeyQ') {
          state.yaw = (state.yaw + 270) % 360;
          state._ghostLocked = null;
          ensureGhost();
        }
        if (e.code === 'KeyR') {
          state.yaw = (state.yaw + 90) % 360;
          state._ghostLocked = null;
          ensureGhost();
        }
        // 1-7 switch prefab (no HUD)
        const digitMap = {
          Digit1: 'house',
          Digit2: 'midrise',
          Digit3: 'skyscraper',
          Digit4: 'ruin',
          Digit5: 'factory',
          Digit6: 'bridge',
          Digit7: 'zipline',
          Digit8: 'spawnAlly',
          Digit9: 'spawnEnemy',
          Digit0: 'aiSpawnAlly',
          Minus: 'aiSpawnEnemy',
        };
        if (digitMap[e.code]) {
          state.prefab = digitMap[e.code];
          state._ghostLocked = null;
          ensureGhost();
          syncFpsHud();
        }
        // [ ] bridge height
        if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
          const order = ['low', 'mid', 'high'];
          let i = order.indexOf(state.bridgeHeight);
          if (i < 0) i = 0;
          i = e.code === 'BracketRight' ? (i + 1) % 3 : (i + 2) % 3;
          state.bridgeHeight = order[i];
          state.prefab = 'bridge';
          state._ghostLocked = null;
          ensureGhost();
        }
        if (e.code === 'Escape') {
          e.preventDefault();
          exitFpsMode(true);
        }
        return;
      }
      if (!state.open) return;
      if (e.code === 'KeyQ') {
        state.yaw = (state.yaw + 270) % 360;
        syncCount();
        state.needsRedraw = true;
      }
      if (e.code === 'KeyR') {
        state.yaw = (state.yaw + 90) % 360;
        syncCount();
        state.needsRedraw = true;
      }
      if (e.code === 'Escape') close();
    });

    global.VF.MapEditor = {
      open: open,
      close: close,
      toggle: toggle,
      enterFps: enterFpsMode,
      exitFps: function () {
        exitFpsMode(true);
      },
      update: updateFpsGhost,
      isOpen: function () {
        return state.open || state.fpsMode;
      },
      isFps: function () {
        return state.fpsMode;
      },
      hasKitLayout: function () {
        return true;
      },
      applyStoredKit: function () {
        return applyMatchMap();
      },
      applyMatchMap: applyMatchMap,
      loadDust2Default: loadDust2Default,
      importMapImage: importMapImage,
      disableKitLayout: disableKitLayout,
      getPlaced: function () {
        return state.placed.slice();
      },
      GRID: GRID,
      HEIGHTS: HEIGHTS,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
