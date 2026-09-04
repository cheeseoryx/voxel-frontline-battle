/*
 * vox.js — Shared .vox (MagicaVoxel) parsing + colour matching for the
 * prop pipeline. Used by both inspect-vox.js (preflight) and
 * bake-vox-prop.js (offline baking) so the two never drift apart.
 *
 * The colour metric is CIE76 (Lab). A weighted-RGB distance was tried first
 * and disagreed with Lab on a third of the house's voxels — it is
 * luma-dominated, so it sent dark olive greens to ROAD and dark browns to
 * ROAD instead of GRASS / ROOF. Lab keeps hue. Do not replace this.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/** MagicaVoxel default palette, used when a .vox file carries no RGBA chunk. */
function defaultPalette() {
  const p = new Array(256).fill(0);
  const ramp = [0, 51, 102, 153, 204, 255];
  let i = 1;
  for (let r = 5; r >= 0; r--) {
    for (let g = 5; g >= 0; g--) {
      for (let b = 5; b >= 0; b--) {
        if (i > 255) break;
        p[i++] = (ramp[r] << 16) | (ramp[g] << 8) | ramp[b];
      }
    }
  }
  return p;
}

/**
 * Parse a MagicaVoxel .vox buffer.
 * .vox is Z-up: SIZE's (x, y, z) = (width, depth, height).
 * Returns { version, models:[{w,d,h,voxels:[{x,y,z,c}]}], palette }.
 */
function parseVox(buf) {
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'VOX ') {
    throw new Error('不是 .vox 文件（缺少 "VOX " 头）。请在 Vengi 里选择 MagicaVoxel 格式导出。');
  }
  const version = buf.readInt32LE(4);
  const models = [];
  let palette = null;
  let pending = null;

  // Chunk: id[4] contentBytes[4] childrenBytes[4] content children
  (function walk(off, end) {
    while (off + 12 <= end) {
      const id = buf.toString('ascii', off, off + 4);
      const contentBytes = buf.readInt32LE(off + 4);
      const childrenBytes = buf.readInt32LE(off + 8);
      const content = off + 12;
      const children = content + contentBytes;

      if (id === 'SIZE') {
        pending = {
          w: buf.readInt32LE(content),
          d: buf.readInt32LE(content + 4),
          h: buf.readInt32LE(content + 8),
        };
      } else if (id === 'XYZI') {
        const n = buf.readInt32LE(content);
        const voxels = new Array(n);
        for (let i = 0; i < n; i++) {
          const o = content + 4 + i * 4;
          voxels[i] = { x: buf[o], y: buf[o + 1], z: buf[o + 2], c: buf[o + 3] };
        }
        models.push(Object.assign({ voxels: voxels }, pending || { w: 0, d: 0, h: 0 }));
        pending = null;
      } else if (id === 'RGBA') {
        // Palette index i maps to entry i-1 in this chunk.
        palette = new Array(256).fill(0);
        for (let i = 0; i < 255; i++) {
          const o = content + i * 4;
          palette[i + 1] = (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
        }
      }

      if (childrenBytes > 0) walk(children, children + childrenBytes);
      off = children + childrenBytes;
    }
  })(8, buf.length);

  return { version, models, palette: palette || defaultPalette() };
}

/** Parse `[BLOCK.NAME]: 0xRRGGBB` entries out of js/voxel-world.js. */
function _parseVoxelWorldTable(reName, re) {
  const src = fs.readFileSync(path.join(ROOT, 'js/voxel-world.js'), 'utf8');
  const block = src.match(reName);
  if (!block) throw new Error('无法在 js/voxel-world.js 中定位 ' + reName + ' 表');
  const out = [];
  let m;
  while ((m = re.exec(block[1]))) {
    out.push({ name: m[1], hex: parseInt(m[2], 16) });
  }
  return out;
}

/** Every block with a colour, straight from the source (no hardcoding). */
function gamePalette() {
  return _parseVoxelWorldTable(
    /const COLORS = \{([\s\S]*?)\n  \};/,
    /\[BLOCK\.([A-Z_]+)\]:\s*(0x[0-9a-fA-F]{6})/g
  );
}

/** name → numeric block id, parsed from `const BLOCK = { NAME: n, ... }`. */
function gameBlockIds() {
  const src = fs.readFileSync(path.join(ROOT, 'js/voxel-world.js'), 'utf8');
  const block = src.match(/const BLOCK = \{([\s\S]*?)\n  \};/);
  if (!block) throw new Error('无法在 js/voxel-world.js 中定位 BLOCK 表');
  const ids = Object.create(null);
  const re = /^\s*([A-Z_]+):\s*(\d+),/gm;
  let m;
  while ((m = re.exec(block[1]))) ids[m[1]] = parseInt(m[2], 10);
  return ids;
}

/** name → hits-to-destroy, parsed from `const BLOCK_HITS = { ... }`. */
function gameBreakableHits() {
  const src = fs.readFileSync(path.join(ROOT, 'js/voxel-world.js'), 'utf8');
  const block = src.match(/const BLOCK_HITS = \{([\s\S]*?)\n  \};/);
  if (!block) throw new Error('无法在 js/voxel-world.js 中定位 BLOCK_HITS 表');
  const out = Object.create(null);
  const re = /\[BLOCK\.([A-Z_]+)\]:\s*(\d+)/g;
  let m;
  while ((m = re.exec(block[1]))) out[m[1]] = parseInt(m[2], 10);
  return out;
}

/** Block names that have a durability value (the keys of BLOCK_HITS). */
function gameBreakableNames() {
  return Object.keys(gameBreakableHits());
}

/** Highest id in the BLOCK table. Prop palettes are allocated above this. */
function maxGameBlockId() {
  const ids = gameBlockIds();
  let max = 0;
  for (const k in ids) if (ids[k] > max) max = ids[k];
  return max;
}

/**
 * The palette a prop may be baked into: solid AND breakable.
 *
 * `_isSolid` (voxel-world.js) is exclusionary — it only clears AIR, WATER,
 * GLASS, SMOKE, SMOKE_LIGHT. GLASS is in BLOCK_HITS but is NOT solid, so it
 * must be dropped here or it bakes into a see-through ghost wall. BEDROCK is
 * not in BLOCK_HITS at all (it is the unbreakable world floor), so filtering
 * by BLOCK_HITS already excludes it.
 */
function solidPalette() {
  const hits = new Set(gameBreakableNames());
  const ids = gameBlockIds();
  return gamePalette()
    .filter(function (c) {
      return hits.has(c.name) && c.name !== 'GLASS';
    })
    .map(function (c) {
      return { name: c.name, hex: c.hex, id: ids[c.name] };
    });
}

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toLab(hex) {
  const r = srgbToLinear((hex >> 16) & 255);
  const g = srgbToLinear((hex >> 8) & 255);
  const b = srgbToLinear(hex & 255);
  let X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X);
  Y = f(Y);
  Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

function colorDist(a, b) {
  const A = toLab(a);
  const B = toLab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

/** The Lab-nearest entry of solidPalette(), i.e. what quantising would pick. */
function nearestMaterial(hex, solid) {
  solid = solid || solidPalette();
  let best = solid[0];
  let bd = Infinity;
  for (const s of solid) {
    const d = colorDist(hex, s.hex);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return { name: best.name, hex: best.hex, id: best.id, dist: bd };
}

/**
 * Hits-to-break for an exact colour, inherited from its nearest material.
 *
 * Source .vox files carry colour but no hardness, and the alternative (letting
 * breakBlock's missing-key default apply) would make every voxel one-shot.
 * Inheriting reproduces the quantised bake's durability on *every* voxel, so
 * an exact-colour re-bake is provably a visual-only change. check-props.js
 * asserts this, so do not swap in a flat constant.
 */
function durabilityFor(hex, solid, hits) {
  hits = hits || gameBreakableHits();
  const near = nearestMaterial(hex, solid);
  return { hits: hits[near.name] != null ? hits[near.name] : 1, near: near };
}

/**
 * The prop's own palette: every distinct colour it actually uses, 1:1.
 *
 * Sorted ascending by hex so the emitted file — and therefore the block ids
 * allocated from it at load time — depend only on the .vox contents. Vengi
 * renumbering its palette slots then cannot shuffle ids.
 *
 * Returns { hexes, localOf, ofIndex } where ofIndex maps a .vox palette index
 * to a 1-based index into hexes (0 = colour unused by this model).
 */
function exactPalette(voxels, palette) {
  const seen = new Set();
  for (const v of voxels) {
    const hex = palette[v.c];
    if (hex != null) seen.add(hex & 0xffffff);
  }
  const hexes = [...seen].sort((a, b) => a - b);
  const localOf = new Map(hexes.map((h, i) => [h, i + 1]));
  const ofIndex = new Uint8Array(256);
  for (let i = 1; i < 256; i++) {
    const h = palette[i];
    if (h != null && localOf.has(h & 0xffffff)) ofIndex[i] = localOf.get(h & 0xffffff);
  }
  return { hexes, localOf, ofIndex };
}

module.exports = {
  ROOT,
  parseVox,
  defaultPalette,
  toLab,
  colorDist,
  gamePalette,
  gameBlockIds,
  gameBreakableNames,
  gameBreakableHits,
  maxGameBlockId,
  solidPalette,
  nearestMaterial,
  durabilityFor,
  exactPalette,
};
