/**
 * render-tuner.js — Dev-only render pipeline parameter panel (F9).
 *
 * PRODUCTION STRIP (delete these 3):
 *   1. This file: js/render-tuner.js
 *   2. <script src="js/render-tuner.js"> in index.html
 *   3. Confirm game does NOT load render config from localStorage without this script
 *
 * KEEP: js/render-config.js (exported numbers stay in the game)
 *
 * Export (Chromium browsers): first click asks you to locate js/render-config.js once
 * via the native save dialog, then writes to it directly on every later click — no
 * manual copy/replace needed. Non-Chromium browsers fall back to download + clipboard.
 * Draft in localStorage is ONLY read when this tuner is loaded.
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};
  if (global.VF._renderTunerMounted) return;
  global.VF._renderTunerMounted = true;

  const DRAFT_KEY = 'vf_small_render_draft_v1';

  // Sections mirror RenderConfig. `toggle: false` = no enable checkbox
  // (toneMapping also does the sRGB encode, so it can never be turned off).
  // Field types: num (slider+box), color (picker), select (dropdown).
  const SCHEMA = [
    {
      id: 'volumetricFog',
      title: '体积雾 Volumetric Fog',
      fields: [
        { key: 'density', label: '密度 Density', min: 0, max: 0.12, step: 0.0005 },
        { key: 'heightFalloff', label: '高度衰减', min: 0.002, max: 0.3, step: 0.002 },
        { key: 'baseHeight', label: '基准高度 Base Y', min: -20, max: 120, step: 1 },
        { key: 'maxDistance', label: '最大距离', min: 50, max: 1200, step: 10 },
        { key: 'steps', label: '步数 Steps (性能)', min: 4, max: 96, step: 1 },
        { key: 'color', label: '雾颜色', type: 'color' },
        { key: 'anisotropy', label: '散射方向性 g', min: -0.9, max: 0.9, step: 0.01 },
        { key: 'sunStrength', label: '阳光散射强度', min: 0, max: 30, step: 0.1 },
        { key: 'noiseScale', label: '噪声缩放', min: 0.001, max: 0.08, step: 0.001 },
        { key: 'noiseStrength', label: '噪声强度', min: 0, max: 1, step: 0.01 },
        { key: 'windSpeed', label: '风速 Wind', min: 0, max: 4, step: 0.05 },
      ],
    },
    {
      id: 'bloom',
      title: '泛光 Bloom',
      fields: [
        { key: 'threshold', label: '阈值 Threshold', min: 0, max: 4, step: 0.01 },
        { key: 'softKnee', label: '软过渡 Soft Knee', min: 0, max: 1, step: 0.01 },
        { key: 'intensity', label: '强度 Intensity', min: 0, max: 3, step: 0.01 },
        { key: 'radius', label: '半径 Radius', min: 0.1, max: 2, step: 0.01 },
      ],
    },
    {
      id: 'toneMapping',
      title: '色调映射 Tone Mapping',
      toggle: false,
      fields: [
        { key: 'exposure', label: '曝光 Exposure', min: 0.05, max: 4, step: 0.01 },
        {
          key: 'mode',
          label: '曲线 Curve',
          type: 'select',
          options: [
            { value: 'aces', label: 'ACES Filmic' },
            { value: 'reinhard', label: 'Reinhard' },
            { value: 'none', label: '无 (Clamp)' },
          ],
        },
      ],
    },
    {
      id: 'colorGrade',
      title: '色彩分级 Color Grading',
      fields: [
        { key: 'saturation', label: '饱和度 Saturation', min: 0, max: 2, step: 0.01 },
        { key: 'contrast', label: '对比度 Contrast', min: 0.5, max: 2, step: 0.01 },
        { key: 'temperature', label: '色温 Temperature', min: -0.5, max: 0.5, step: 0.005 },
        { key: 'tint', label: '色调 Tint', min: -0.5, max: 0.5, step: 0.005 },
        { key: 'lift', label: '提升 Lift', min: -0.2, max: 0.2, step: 0.005 },
        { key: 'gain', label: '增益 Gain', min: 0.5, max: 2, step: 0.01 },
      ],
    },
    {
      id: 'vignette',
      title: '暗角 Vignette',
      fields: [
        { key: 'intensity', label: '强度 Intensity', min: 0, max: 1, step: 0.01 },
        { key: 'radius', label: '半径 Radius', min: 0.1, max: 1.5, step: 0.01 },
        { key: 'smoothness', label: '柔和度 Smoothness', min: 0.01, max: 1.5, step: 0.01 },
      ],
    },
    {
      id: 'film',
      title: '色差 / 噪点 Film',
      fields: [
        { key: 'aberration', label: '色差 Aberration', min: 0, max: 0.02, step: 0.0002 },
        { key: 'grain', label: '噪点 Grain', min: 0, max: 0.2, step: 0.002 },
      ],
    },
    {
      id: 'lighting',
      title: '光照 Lighting',
      toggle: false,
      fields: [
        { key: 'sunAzimuth', label: '太阳方位 Azimuth', min: 0, max: 360, step: 1 },
        { key: 'sunElevation', label: '太阳高度 Elevation', min: -10, max: 90, step: 0.5 },
        { key: 'sunColor', label: '阳光颜色', type: 'color' },
        { key: 'sunIntensity', label: '阳光强度', min: 0, max: 4, step: 0.01 },
        { key: 'ambientSkyColor', label: '环境光·天空色', type: 'color' },
        { key: 'ambientGroundColor', label: '环境光·地面色', type: 'color' },
        { key: 'ambientIntensity', label: '环境光强度', min: 0, max: 3, step: 0.01 },
        { key: 'fillColor', label: '补光颜色', type: 'color' },
        { key: 'fillIntensity', label: '补光强度', min: 0, max: 2, step: 0.01 },
      ],
    },
    {
      id: 'sky',
      title: '天空盒 Sky',
      fields: [
        { key: 'hdriUrl', label: 'HDRI 文件', type: 'hdri' },
        { key: 'hdriIntensity', label: 'HDRI 亮度', min: 0, max: 4, step: 0.01 },
        { key: 'hdriRotation', label: 'HDRI 旋转 (°)', min: 0, max: 360, step: 1 },
        { key: 'hdriEnvIntensity', label: 'HDRI 环境光强度', min: 0, max: 4, step: 0.01 },
        { key: 'zenithColor', label: '天顶色 Zenith', type: 'color' },
        { key: 'horizonColor', label: '地平线色 Horizon', type: 'color' },
        { key: 'groundColor', label: '地面色 Ground', type: 'color' },
        { key: 'horizonSharpness', label: '渐变锐度', min: 0.1, max: 3, step: 0.01 },
        { key: 'sunSize', label: '太阳大小 (°)', min: 0.2, max: 15, step: 0.1 },
        { key: 'sunIntensity', label: '太阳亮度', min: 0, max: 3, step: 0.01 },
        { key: 'haloFalloff', label: '光晕收敛', min: 2, max: 200, step: 1 },
      ],
    },
    {
      id: 'fog',
      title: '线性距离雾 Linear Fog',
      fields: [
        { key: 'near', label: '起始距离 Near', min: 0, max: 900, step: 5 },
        { key: 'far', label: '结束距离 Far', min: 50, max: 2000, step: 10 },
      ],
    },
  ];

  function ensureConfig() {
    if (!global.VF.RenderConfig) global.VF.RenderConfig = { enabled: true, toneMapping: {} };
    if (!global.VF.RenderConfigDefaults) {
      global.VF.RenderConfigDefaults = JSON.parse(JSON.stringify(global.VF.RenderConfig));
    }
  }

  function deepAssign(target, src) {
    if (!src || typeof src !== 'object') return target;
    Object.keys(src).forEach(function (k) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        deepAssign(target[k], src[k]);
      } else {
        target[k] = src[k];
      }
    });
    return target;
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(global.VF.RenderConfig));
    } catch (e) {
      /* ignore */
    }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      deepAssign(global.VF.RenderConfig, JSON.parse(raw));
    } catch (e) {
      /* ignore */
    }
  }

  function setPath(group, key, value) {
    ensureConfig();
    if (!global.VF.RenderConfig[group]) global.VF.RenderConfig[group] = {};
    global.VF.RenderConfig[group][key] = value;
    saveDraft();
  }

  function setEnabled(value) {
    ensureConfig();
    global.VF.RenderConfig.enabled = value;
    saveDraft();
  }

  function restoreAll() {
    ensureConfig();
    if (!global.VF.RenderConfigDefaults) return;
    global.VF.RenderConfig = JSON.parse(JSON.stringify(global.VF.RenderConfigDefaults));
    saveDraft();
    rebuildBody();
  }

  function buildConfigSource() {
    ensureConfig();
    const json = JSON.stringify(global.VF.RenderConfig, null, 2);
    return (
      '/**\n' +
      ' * render-config.js — Baked render pipeline defaults (KEEP on production).\n' +
      ' * Generated by render-tuner Export. Replace this file, then delete render-tuner.js for ship.\n' +
      ' */\n' +
      '(function (global) {\n' +
      "  'use strict';\n" +
      '  global.VF = global.VF || {};\n\n' +
      '  global.VF.RenderConfig = ' +
      json +
      ';\n' +
      "})(typeof window !== 'undefined' ? window : globalThis);\n"
    );
  }

  function downloadFallback(body) {
    const blob = new Blob([body], { type: 'application/javascript;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'render-config.js';
    a.click();
    URL.revokeObjectURL(a.href);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(body);
      }
    } catch (e) {
      /* ignore */
    }
    setStatus('已下载 render-config.js（当前浏览器不支持直接写入，需手动替换）');
  }

  const HANDLE_DB = 'vf-tuner-fs';
  const HANDLE_STORE = 'handles';
  const HANDLE_KEY = 'render-config';
  let cachedHandle = null;

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

  async function getStoredHandle() {
    try {
      const db = await openHandleDB();
      return await new Promise(function (resolve, reject) {
        const tx = db.transaction(HANDLE_STORE, 'readonly');
        const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
        req.onsuccess = function () {
          resolve(req.result || null);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    } catch (e) {
      return null;
    }
  }

  async function storeHandle(handle) {
    try {
      const db = await openHandleDB();
      await new Promise(function (resolve, reject) {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
        tx.oncomplete = resolve;
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    } catch (e) {
      /* ignore */
    }
  }

  async function pickHandle() {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'render-config.js',
      types: [{ description: 'JavaScript', accept: { 'text/javascript': ['.js'] } }],
    });
    await storeHandle(handle);
    cachedHandle = handle;
    return handle;
  }

  async function resolveWritableHandle() {
    let handle = cachedHandle || (await getStoredHandle());
    if (handle) {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        handle = null;
      }
    }
    if (!handle) handle = await pickHandle();
    cachedHandle = handle;
    return handle;
  }

  async function exportConfig() {
    const body = buildConfigSource();

    if (!window.showSaveFilePicker) {
      downloadFallback(body);
      return;
    }

    try {
      const handle = await resolveWritableHandle();
      const writable = await handle.createWritable();
      await writable.write(body);
      await writable.close();
      setStatus('已写入 ' + handle.name + '（' + new Date().toLocaleTimeString() + '）');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.warn('[render-tuner] 直接写入失败，回退为下载', e);
      downloadFallback(body);
    }
  }

  async function relocateFile() {
    try {
      await pickHandle();
      setStatus('已重新选择保存位置，下次导出将写入该文件');
    } catch (e) {
      /* user cancelled */
    }
  }

  let statusEl = null;
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function makeRow(label, value, min, max, step, onChange) {
    const row = el('div', 'render-tuner-row');
    row.appendChild(el('label', 'render-tuner-label', label));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.className = 'render-tuner-range';
    const num = document.createElement('input');
    num.type = 'number';
    num.min = String(min);
    num.max = String(max);
    num.step = String(step);
    num.value = String(value);
    num.className = 'render-tuner-num';
    function sync(v) {
      const n = Number(v);
      if (!isFinite(n)) return;
      range.value = String(n);
      num.value = String(n);
      onChange(n);
    }
    range.addEventListener('input', function () {
      sync(range.value);
    });
    num.addEventListener('change', function () {
      sync(num.value);
    });
    row.appendChild(range);
    row.appendChild(num);
    return row;
  }

  function makeCheckboxRow(label, checked, onChange) {
    const row = el('div', 'render-tuner-row render-tuner-row-checkbox');
    row.appendChild(el('label', 'render-tuner-label', label));
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!checked;
    box.addEventListener('change', function () {
      onChange(box.checked);
    });
    row.appendChild(box);
    return row;
  }

  /**
   * HDRI row: a path text box (what gets exported), a "浏览" button that
   * previews a local file via a blob URL, and a clear button.
   *
   * A blob: URL is session-only — it cannot be exported into render-config.js.
   * So the row warns when the current value is a blob and tells the user to
   * copy the file into assets/ and type the relative path for a permanent set.
   */
  function makeHdriRow(label, value, onChange) {
    const wrap = el('div', 'render-tuner-hdri');

    const row = el('div', 'render-tuner-row render-tuner-row-hdri');
    row.appendChild(el('label', 'render-tuner-label', label));

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'render-tuner-num';
    text.placeholder = 'assets/sky/dusk.exr';
    text.value = value == null ? '' : String(value);
    text.title = '相对路径或 URL（.exr / .hdr / .jpg）';

    const browse = el('button', 'render-tuner-mini', '浏览');
    browse.type = 'button';
    browse.title = '选择本地 .exr/.hdr 文件预览（仅本次会话有效）';

    const reload = el('button', 'render-tuner-mini', '↻');
    reload.type = 'button';
    reload.title = '重新加载当前路径（改正拼写或替换文件后用）';

    row.appendChild(text);
    row.appendChild(browse);
    row.appendChild(reload);
    wrap.appendChild(row);

    const note = el('div', 'render-tuner-note', '');
    wrap.appendChild(note);

    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.exr,.hdr,.jpg,.jpeg,.png,.webp';
    picker.style.display = 'none';
    wrap.appendChild(picker);

    let blobUrl = null;
    function setNote() {
      const v = text.value.trim();
      const rs = global.VF.game && global.VF.game.renderScene;
      const st = rs && rs.getSkyStatus ? rs.getSkyStatus() : null;
      if (!v) {
        note.textContent = '空 = 使用程序化天空';
        note.className = 'render-tuner-note';
        return;
      }
      if (v.indexOf('blob:') === 0) {
        note.textContent = '⚠ 本地预览，导出后失效 — 请把文件放进 assets/ 并填相对路径';
        note.className = 'render-tuner-note warn';
        return;
      }
      if (st && st.status === 'error') {
        note.textContent = '✕ ' + (st.error || '加载失败') + '（已回退程序化天空）';
        note.className = 'render-tuner-note warn';
      } else if (st && st.status === 'loading') {
        note.textContent = '… 加载中';
        note.className = 'render-tuner-note';
      } else if (st && st.active) {
        note.textContent = '✓ 已加载';
        note.className = 'render-tuner-note ok';
      } else {
        note.textContent = '';
        note.className = 'render-tuner-note';
      }
    }

    function commit(v) {
      text.value = v;
      onChange(v);
      setNote();
      // status is async — re-check shortly after the load settles
      setTimeout(setNote, 600);
      setTimeout(setNote, 2000);
    }

    text.addEventListener('change', function () {
      commit(text.value.trim());
    });
    browse.addEventListener('click', function () {
      picker.click();
    });
    reload.addEventListener('click', function () {
      const rs = global.VF.game && global.VF.game.renderScene;
      const v = text.value.trim();
      if (!rs || !rs.loadSkyTexture || !v) return;
      const cfg = (global.VF.RenderConfig && global.VF.RenderConfig.sky) || {};
      rs.loadSkyTexture(v, cfg.hdriAsEnvironment !== false, true);
      note.textContent = '… 重新加载';
      note.className = 'render-tuner-note';
      setTimeout(setNote, 800);
      setTimeout(setNote, 2500);
    });
    picker.addEventListener('change', function () {
      const f = picker.files && picker.files[0];
      if (!f) return;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      // keep the real extension so the loader picks EXR vs RGBE correctly
      const ext = f.name.split('.').pop().toLowerCase();
      blobUrl = URL.createObjectURL(f) + '#.' + ext;
      commit(blobUrl);
    });

    setNote();
    return wrap;
  }

  function makeColorRow(label, value, onChange) {
    const row = el('div', 'render-tuner-row render-tuner-row-color');
    row.appendChild(el('label', 'render-tuner-label', label));
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'render-tuner-color';
    picker.value = normalizeHex(value);
    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'render-tuner-num';
    text.value = picker.value;
    picker.addEventListener('input', function () {
      text.value = picker.value;
      onChange(picker.value);
    });
    text.addEventListener('change', function () {
      const v = normalizeHex(text.value);
      text.value = v;
      picker.value = v;
      onChange(v);
    });
    row.appendChild(picker);
    row.appendChild(text);
    return row;
  }

  function normalizeHex(v) {
    if (typeof v === 'number') {
      return '#' + ('000000' + (v & 0xffffff).toString(16)).slice(-6);
    }
    const s = String(v == null ? '' : v).trim();
    const m = /^#?([0-9a-fA-F]{6})$/.exec(s);
    if (m) return '#' + m[1].toLowerCase();
    const short = /^#?([0-9a-fA-F]{3})$/.exec(s);
    if (short) {
      const t = short[1];
      return '#' + t[0] + t[0] + t[1] + t[1] + t[2] + t[2];
    }
    return '#ffffff';
  }

  function makeSelectRow(label, value, options, onChange) {
    const row = el('div', 'render-tuner-row render-tuner-row-select');
    row.appendChild(el('label', 'render-tuner-label', label));
    const sel = document.createElement('select');
    sel.className = 'render-tuner-select';
    options.forEach(function (o) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = value;
    sel.addEventListener('change', function () {
      onChange(sel.value);
    });
    row.appendChild(sel);
    return row;
  }

  let panel = null;
  let bodyEl = null;

  function rebuildBody() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    ensureConfig();
    const cfg = global.VF.RenderConfig;

    const masterSec = el('section', 'render-tuner-section');
    masterSec.appendChild(el('h3', null, '总开关'));
    masterSec.appendChild(
      makeCheckboxRow('启用后处理管线', cfg.enabled !== false, function (v) {
        setEnabled(v);
      })
    );
    bodyEl.appendChild(masterSec);

    SCHEMA.forEach(function (section) {
      const group = cfg[section.id] || (cfg[section.id] = {});
      const sec = el('section', 'render-tuner-section');

      const rows = el('div', 'render-tuner-rows');
      if (section.toggle !== false && group.enabled === false) {
        rows.classList.add('render-tuner-rows-off');
      }

      const head = el('div', 'render-tuner-head');
      head.appendChild(el('h3', null, section.title));
      if (section.toggle !== false) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = group.enabled !== false;
        box.title = '启用 ' + section.title;
        box.addEventListener('change', function () {
          setPath(section.id, 'enabled', box.checked);
          rows.classList.toggle('render-tuner-rows-off', !box.checked);
        });
        head.appendChild(box);
      }
      sec.appendChild(head);

      section.fields.forEach(function (f) {
        const cur = group[f.key];
        if (f.type === 'color') {
          rows.appendChild(
            makeColorRow(f.label, cur, function (v) {
              setPath(section.id, f.key, v);
            })
          );
        } else if (f.type === 'hdri') {
          rows.appendChild(
            makeHdriRow(f.label, cur, function (v) {
              setPath(section.id, f.key, v);
            })
          );
        } else if (f.type === 'select') {
          rows.appendChild(
            makeSelectRow(f.label, cur == null ? f.options[0].value : cur, f.options, function (v) {
              setPath(section.id, f.key, v);
            })
          );
        } else {
          const val = typeof cur === 'number' ? cur : f.min;
          rows.appendChild(
            makeRow(f.label, val, f.min, f.max, f.step, function (n) {
              setPath(section.id, f.key, n);
            })
          );
        }
      });

      sec.appendChild(rows);
      bodyEl.appendChild(sec);
    });
  }

  function injectStyles() {
    if (document.getElementById('render-tuner-css')) return;
    const s = document.createElement('style');
    s.id = 'render-tuner-css';
    s.textContent =
      '.vf-dev-toolbar{position:fixed;top:10px;right:10px;z-index:100000;display:flex;gap:6px;' +
      'padding:6px;background:rgba(18,20,24,.92);border:1px solid #3a3d42;border-radius:8px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.45);font:12px/1.2 system-ui,sans-serif}' +
      '.vf-dev-toolbar button{background:#2a2e33;color:#f0c060;border:1px solid #4a4540;border-radius:6px;' +
      'padding:6px 10px;cursor:pointer;font-size:12px}' +
      '.vf-dev-toolbar button:hover,.vf-dev-toolbar button.active{background:#3a3530;filter:brightness(1.08)}' +
      '.render-tuner-panel{position:fixed;top:52px;right:12px;z-index:99999;width:min(360px,92vw);' +
      'max-height:min(84vh,860px);display:flex;flex-direction:column;background:#1a1c1f;color:#e8e6e1;' +
      'border:1px solid #3a3d42;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.55);' +
      'font:13px/1.35 system-ui,sans-serif}' +
      '.render-tuner-panel.hidden{display:none!important}' +
      '.render-tuner-top{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #333;' +
      'background:#121417;flex-shrink:0}' +
      '.render-tuner-top h2{flex:1;margin:0;font-size:14px;font-weight:700;letter-spacing:.04em}' +
      '.render-tuner-btn{background:#2a2e33;color:#60c0f0;border:1px solid #40454a;' +
      'border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}' +
      '.render-tuner-btn:hover{background:#303a40}' +
      '.render-tuner-body{overflow:auto;padding:8px 10px 14px;flex:1}' +
      '.render-tuner-section{margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #2a2d32}' +
      '.render-tuner-head{display:flex;align-items:center;gap:8px;margin:0 0 6px}' +
      '.render-tuner-head h3{flex:1;margin:0;font-size:12px;color:#80b8d0;font-weight:600}' +
      '.render-tuner-head input[type=checkbox]{accent-color:#40a0e0;cursor:pointer}' +
      '.render-tuner-section h3{margin:0 0 8px;font-size:12px;color:#80b8d0;font-weight:600}' +
      '.render-tuner-rows-off{opacity:.35;pointer-events:none}' +
      '.render-tuner-row{display:grid;grid-template-columns:1fr 1.1fr 58px;gap:6px;align-items:center;margin:5px 0}' +
      '.render-tuner-row-checkbox{grid-template-columns:1fr auto}' +
      '.render-tuner-row-color{grid-template-columns:1fr 34px 74px}' +
      '.render-tuner-row-select{grid-template-columns:1fr auto}' +
      '.render-tuner-row-hdri{grid-template-columns:1fr 1.2fr auto auto}' +
      '.render-tuner-hdri{margin:5px 0}' +
      '.render-tuner-mini{background:#2a2e33;color:#60c0f0;border:1px solid #40454a;' +
      'border-radius:4px;padding:3px 7px;cursor:pointer;font-size:11px;white-space:nowrap}' +
      '.render-tuner-mini:hover{background:#303a40}' +
      '.render-tuner-note{font-size:10px;color:#888;padding:2px 0 0 2px;line-height:1.3}' +
      '.render-tuner-note.warn{color:#e0a050}' +
      '.render-tuner-note.ok{color:#60c080}' +
      '.render-tuner-label{font-size:11px;color:#b0aea8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.render-tuner-range{width:100%;accent-color:#40a0e0}' +
      '.render-tuner-color{width:100%;height:22px;padding:0;background:#0e1012;' +
      'border:1px solid #333;border-radius:4px;cursor:pointer}' +
      '.render-tuner-select{background:#0e1012;border:1px solid #333;color:#eee;' +
      'border-radius:4px;padding:3px 4px;font-size:11px}' +
      '.render-tuner-num{width:100%;background:#0e1012;border:1px solid #333;color:#eee;border-radius:4px;' +
      'padding:3px 4px;font-size:11px}' +
      '.render-tuner-hint{padding:6px 12px 10px;font-size:10px;color:#888;border-top:1px solid #2a2d32}';
    document.head.appendChild(s);
  }

  function ensureDevToolbar() {
    let bar = document.getElementById('vf-dev-toolbar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'vf-dev-toolbar';
    bar.className = 'vf-dev-toolbar';
    document.body.appendChild(bar);
    return bar;
  }

  function setOpen(open) {
    if (!panel) return;
    if (open) {
      panel.classList.remove('hidden');
      rebuildBody();
    } else {
      panel.classList.add('hidden');
    }
    const btn = document.getElementById('vf-dev-btn-render');
    if (btn) btn.classList.toggle('active', open);
  }

  function toggleOpen() {
    if (!panel) return;
    setOpen(panel.classList.contains('hidden'));
  }

  function mount() {
    ensureConfig();
    loadDraft();
    injectStyles();

    const bar = ensureDevToolbar();
    let btn = document.getElementById('vf-dev-btn-render');
    if (!btn) {
      btn = el('button', null, '渲染 F9');
      btn.id = 'vf-dev-btn-render';
      btn.type = 'button';
      btn.title = '后处理参数';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        toggleOpen();
      });
      bar.appendChild(btn);
    }

    panel = el('div', 'render-tuner-panel hidden');
    panel.id = 'render-tuner-panel';

    const top = el('div', 'render-tuner-top');
    top.appendChild(el('h2', null, '后处理参数'));
    const exportBtn = el('button', 'render-tuner-btn', '导出');
    exportBtn.type = 'button';
    exportBtn.title = window.showSaveFilePicker
      ? '写入 render-config.js（首次会要求选择文件位置）'
      : '下载 render-config.js（当前浏览器不支持直接写入，需手动替换）';
    exportBtn.addEventListener('click', exportConfig);
    const relocateBtn = el('button', 'render-tuner-btn', '换文件');
    relocateBtn.type = 'button';
    relocateBtn.title = '重新选择导出要写入的 render-config.js 位置';
    relocateBtn.addEventListener('click', relocateFile);
    relocateBtn.style.display = window.showSaveFilePicker ? '' : 'none';
    const resetBtn = el('button', 'render-tuner-btn', '还原');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', restoreAll);
    const closeBtn = el('button', 'render-tuner-btn', '×');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', function () {
      setOpen(false);
    });
    top.appendChild(exportBtn);
    top.appendChild(relocateBtn);
    top.appendChild(resetBtn);
    top.appendChild(closeBtn);
    panel.appendChild(top);

    bodyEl = el('div', 'render-tuner-body');
    panel.appendChild(bodyEl);

    statusEl = el(
      'div',
      'render-tuner-hint',
      window.showSaveFilePicker
        ? 'F9 开关 · 导出会直接写入已选定的 render-config.js'
        : 'F9 开关 · 导出 render-config.js'
    );
    panel.appendChild(statusEl);
    document.body.appendChild(panel);
    rebuildBody();

    document.addEventListener('keydown', function (e) {
      if (e.code !== 'F9') return;
      e.preventDefault();
      toggleOpen();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
