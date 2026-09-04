/**
 * prop-palette.js — Allocate real block ids for a baked prop's exact colours.
 *
 * Baked props (`--exact`) carry their own palette so importing a model never
 * touches voxel-world.js's BLOCK / COLORS / BLOCK_HITS tables. This module
 * hands out ids above the highest engine id and injects colour + durability
 * into VF.BLOCK_COLORS / VF.BLOCK_HITS, which voxel-world.js exports BY
 * REFERENCE and reads live at mesh time (`COLORS[type]`, voxel-world.js:2834)
 * — so nothing needs invalidating and the engine stays at 20 block types.
 *
 * New ids are solid for free: _isSolid (voxel-world.js:2598) is exclusionary,
 * clearing only AIR / WATER / GLASS / SMOKE / SMOKE_LIGHT. Collision, bullet
 * DDA and AI pathing therefore work with no further wiring.
 *
 * MUST load after js/voxel-world.js and before any js/props/<id>.js. Baked
 * prop files call register() themselves on the last line, so registration is
 * complete during document parse — long before a VoxelWorld exists. Registering
 * lazily at first stamp would leave a window where a chunk meshes an unknown id
 * and bakes the 0xffffff fallback into its vertex colours; only a full chunk
 * rebuild repairs that, and a silently white building is a miserable bug.
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};
  const VF = global.VF;

  /**
   * hex → block id, shared across ALL props: two models using the same colour
   * cost one id. That is what keeps the 236 free ids viable as more models land.
   */
  const byHex = new Map();
  let baseId = 0;
  let nextId = 0;

  function ensureBase() {
    if (baseId) return true;
    if (!VF.BLOCK || !VF.BLOCK_COLORS || !VF.BLOCK_HITS) return false;
    let max = 0;
    for (const k in VF.BLOCK) if (VF.BLOCK[k] > max) max = VF.BLOCK[k];
    baseId = nextId = max + 1; // 20 today
    return true;
  }

  /** Cheap nearest already-allocated id. Only used on id exhaustion. */
  function nearestKnown(hex) {
    const r = (hex >> 16) & 255;
    const g = (hex >> 8) & 255;
    const b = hex & 255;
    let best = VF.BLOCK.CONCRETE;
    let bd = Infinity;
    byHex.forEach(function (id, h) {
      const dr = ((h >> 16) & 255) - r;
      const dg = ((h >> 8) & 255) - g;
      const db = (h & 255) - b;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) { bd = d; best = id; }
    });
    return best;
  }

  /**
   * Register VF.PROPS[propId].pal, then rewrite that prop's RLE from 1-based
   * palette indices to real block ids IN PLACE — so prop-stamp.js's decode()
   * needs no change and legacy props (no `pal`) keep working untouched.
   *
   * Idempotent: `prop.ids` is the guard and is checked first, so match restarts
   * and double registration are a single lookup.
   */
  function register(propId) {
    const prop = VF.PROPS && VF.PROPS[propId];
    if (!prop) return null;
    if (prop.ids) return prop.ids; // already registered
    if (!prop.pal || !prop.pal.length) return null; // legacy prop: absolute ids
    if (!ensureBase()) {
      console.error('[PropPalette] js/voxel-world.js 必须先加载，' + propId + ' 注册失败');
      return null;
    }

    const pal = prop.pal;
    const ids = new Array(pal.length);
    for (let i = 0; i < pal.length; i++) {
      const hex = pal[i] & 0xffffff;
      let id = byHex.get(hex);
      if (id == null) {
        if (nextId > 255) {
          // world.blocks is a Uint8Array — id 256 wraps to AIR and would punch
          // holes through the building. Degrade loudly instead.
          id = nearestKnown(hex);
          console.error('[PropPalette] block id 已用尽 (255)：' + propId + ' 的 #' +
            hex.toString(16).padStart(6, '0') + ' 退化为最接近的已注册材质 ' + id);
        } else {
          id = nextId++;
          byHex.set(hex, id);
        }
      }
      VF.BLOCK_COLORS[id] = hex;
      // First registration wins, so two props sharing a hex cannot fight over
      // durability. check-props.js asserts they never disagree in the first place.
      if (VF.BLOCK_HITS[id] == null) {
        VF.BLOCK_HITS[id] = (prop.hits && prop.hits[i]) || 1;
      }
      ids[i] = id;
    }

    const rle = prop.rle;
    for (let i = 0; i < rle.length; i += 2) {
      if (rle[i]) rle[i] = ids[rle[i] - 1];
    }
    prop.ids = ids;
    return ids;
  }

  /** True for ids this module allocated — used by the ui.js map colour tables. */
  function isPropId(id) {
    return baseId > 0 && id >= baseId && id < nextId;
  }

  /**
   * Register the SHARED prop palette (bake-props.js) and rewrite every shared
   * prop's RLE in place. Loads from js/props/props-bundle.js, which sets
   * VF.PROP_PALETTE = { pal, hits } and VF.PROP_MANIFEST = [...] and must load
   * AFTER all js/props/<id>.js so every prop's rle is present to rewrite.
   *
   * Shared props carry no per-prop `pal`/`hits`: their rle holds 1-based indices
   * into VF.PROP_PALETTE.pal. Legacy exact props (own `pal`) are untouched here
   * and still go through register() from their own file's last line.
   */
  function registerShared() {
    const shared = VF.PROP_PALETTE;
    if (!shared || !shared.pal || !shared.pal.length) return null;
    if (shared.ids) return shared.ids; // already registered
    if (!ensureBase()) {
      console.error('[PropPalette] js/voxel-world.js 必须先加载，共享调色板注册失败');
      return null;
    }

    const pal = shared.pal;
    const ids = new Array(pal.length);
    for (let i = 0; i < pal.length; i++) {
      const hex = pal[i] & 0xffffff;
      let id = byHex.get(hex);
      if (id == null) {
        if (nextId > 255) {
          id = nearestKnown(hex);
          console.error('[PropPalette] block id 已用尽 (255)：共享调色板 #' +
            hex.toString(16).padStart(6, '0') + ' 退化为最接近的已注册材质 ' + id);
        } else {
          id = nextId++;
          byHex.set(hex, id);
        }
      }
      VF.BLOCK_COLORS[id] = hex;
      if (VF.BLOCK_HITS[id] == null) {
        VF.BLOCK_HITS[id] = (shared.hits && shared.hits[i]) || 1;
      }
      ids[i] = id;
    }
    shared.ids = ids;

    // Rewrite each shared prop's rle from 1-based palette index → real block id.
    for (const propId in (VF.PROPS || {})) {
      const prop = VF.PROPS[propId];
      if (!prop || !prop.rle) continue;
      if (prop.ids) continue;               // already registered (idempotent)
      if (prop.pal && prop.pal.length) continue; // legacy exact prop: own palette
      const rle = prop.rle;
      for (let i = 0; i < rle.length; i += 2) {
        if (rle[i]) rle[i] = ids[rle[i] - 1];
      }
      prop.ids = ids;
    }
    return ids;
  }

  VF.PropPalette = {
    register: register,
    registerShared: registerShared,
    isPropId: isPropId,
    baseId: function () { return baseId; },
    nextId: function () { return nextId; },
    usedIds: function () { return baseId ? nextId - baseId : 0; },
    freeIds: function () { return baseId ? 256 - nextId : 0; },
    byHex: byHex,
  };
})(typeof window !== 'undefined' ? window : globalThis);
