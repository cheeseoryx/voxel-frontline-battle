/**
 * prop-stamp.js — Place baked .vox props (VF.PROPS) into the world.
 *
 * Position-independent: later editor integration only needs to add a PREFABS
 * entry; the stamp itself stays here. Reuses VoxelWorld's own surface/river/
 * register/set APIs rather than inventing new terrain math.
 *
 * INVARIANT: a prop body must never be written at or below groundY.
 * _isTerrainFill (voxel-world.js:2613) treats ANY solid block at/below groundY
 * as natural terrain, and breakBlock refuses to break terrain fill — so a
 * sunken prop would become unbreakable and get skipped by the voxel mesher.
 * The body starts at gy + 1 below; only the pad itself sits at gy.
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};
  global.VF.Props = global.VF.Props || {};

  function decode(prop) {
    const vol = new Uint8Array(prop.w * prop.d * prop.h);
    let o = 0;
    for (let i = 0; i < prop.rle.length; i += 2) {
      vol.fill(prop.rle[i], o, o + prop.rle[i + 1]);
      o += prop.rle[i + 1];
    }
    return vol;
  }

  /**
   * Stamp a baked prop. opts: { cx, cz, yaw } — cx/cz world coords of the
   * centre, yaw in degrees (0/90/180/270). Returns the same shape as
   * VoxelWorld.stampEditorPrefab so an editor can treat props like any kit.
   */
  function stamp(world, propId, opts) {
    opts = opts || {};
    const prop = global.VF.PROPS && global.VF.PROPS[propId];
    if (!prop || !world || !world.set) return null;
    // Safety net: baked props self-register at load, so this is normally a no-op.
    // It only matters if a prop is ever added after voxel-world.js has loaded.
    if (prop.pal && !prop.ids && global.VF.PropPalette) {
      global.VF.PropPalette.register(propId);
    }
    const B = global.VF.BLOCK || { AIR: 0, WATER: 8, STONE: 3, CONCRETE: 4 };

    const W = prop.w;
    const D = prop.d;
    const H = prop.h;
    const yawDeg = (((opts.yaw || 0) % 360) + 360) % 360;
    const q = Math.round(yawDeg / 90) % 4;
    const rotW = q & 1 ? D : W;
    const rotD = q & 1 ? W : D;
    const cx = Math.floor(opts.cx != null ? opts.cx : 0);
    const cz = Math.floor(opts.cz != null ? opts.cz : 0);
    const ox = cx - (rotW >> 1);
    const oz = cz - (rotD >> 1);

    // Reject water, same guard as _placeHouse / _placeWarehouse.
    if (world._riverInfo && world._riverInfo(cx, cz).inWater) return null;

    const size = world.worldSize || 1024;
    const surfaceAt = function (x, z) {
      return (world._surface ? world._surface(x, z) : 9) || 9;
    };

    // Pad height = HIGHEST surface under the footprint, not the centre sample.
    //
    // Flattening to the centre leaves the uphill side of the terrain standing
    // above the pad, and the heightfield terrain mesh (terrain-fine.js
    // _buildTerrainChunkMesh) then draws that higher ground right over the
    // prop — the building looks like its lower third was chopped off. The
    // voxels are all there and breakable; they are simply occluded.
    //
    // Taking the max means the prop always clears the slope. The downhill side
    // gets a visible STONE plinth (see the fill loop below), which reads as a
    // terraced foundation.
    let gy = surfaceAt(cx, cz);
    let lowest = gy;
    for (let dz = 0; dz < rotD; dz++) {
      for (let dx = 0; dx < rotW; dx++) {
        const x = ox + dx;
        const z = oz + dz;
        if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
        const s = surfaceAt(x, z);
        if (s > gy) gy = s;
        if (s < lowest) lowest = s;
      }
    }
    // Keep the body inside the world: H above the pad, plus headroom for cap.
    //
    // The clamp is two-sided on purpose. Lowering the pad to fit a tall model
    // defeats the max-surface logic above (the terrain mesh then draws over the
    // model's lower portion), and once H exceeds world.height - 4 the pad goes
    // zero or negative — the body lands at/below groundY, where _isTerrainFill
    // makes it unbreakable AND unmeshed. That failure is invisible in game, so
    // refuse the placement and say why instead.
    const worldH = world.height || 101;
    const maxGy = worldH - H - 4;
    if (maxGy < 1) {
      // Bare `console`, not `global.console`: `global` here is `window`, and the
      // headless test context puts console on the context rather than on window.
      console.error('[Props] ' + propId + ' 高 ' + H + ' 米，超过世界高度上限 ' +
        (worldH - 5) + ' 米，无法摆放（会被埋进地下且不可破坏）。请让美术降低模型高度。');
      return null;
    }
    if (gy > maxGy) gy = maxGy;
    const cap = gy + H + 3;

    // Flatten the site to gy (like _clearFlagPlaza, but rectangular):
    //   raise low spots with STONE, cut high spots to AIR, lay a CONCRETE pad,
    //   and — critically — sync groundY + terrainH so the 10cm heightfield
    //   (which drives player collision) matches the flattened pad.
    //
    // The fill floor reaches down to the lowest surface under the footprint
    // (not a fixed 8 blocks) so a prop on a steep slope still rests on solid
    // ground instead of floating over a gap on its downhill side.
    const fillFloor = Math.max(1, Math.min(gy - 8, lowest - 2));
    for (let dz = 0; dz < rotD; dz++) {
      for (let dx = 0; dx < rotW; dx++) {
        const x = ox + dx;
        const z = oz + dz;
        if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
        for (let y = fillFloor; y < gy; y++) {
          const cur = world.get(x, y, z);
          if (cur === B.AIR || cur === B.WATER) world.set(x, y, z, B.STONE);
        }
        for (let y = gy + 1; y <= cap && y < (world.height || 101); y++) {
          world.set(x, y, z, B.AIR);
        }
        world.set(x, gy, z, B.CONCRETE);
        if (world.groundY) world.groundY[z * size + x] = gy;
        if (world.terrainH) world.terrainH[z * size + x] = gy + 1;
      }
    }

    // Register for AI / minimap awareness.
    if (world._registerBuilding) world._registerBuilding(ox, oz, rotW, rotD);

    // Claim the footprint so later generation stages don't carve into the prop.
    //
    // Props are stamped inside island.stamp(), but three stages run AFTER it
    // and used to overwrite prop voxels wholesale:
    //   - Bases.rebuildAfterMapGen  (main.js) -> _setWalkColumn / _gradeGateExit
    //   - _clearFlagPlaza           (island-conquest.js, after stampVoxProps)
    //   - setTerrainTop / deformTerrainCircle at runtime
    // Each of those now consults world.isPropClaimed() before writing.
    if (world.claimPropArea) world.claimPropArea(ox, oz, rotW, rotD, gy, gy + H);

    // Stamp voxels with yaw rotation (local bx/by → world x/z).
    //
    // .vox is right-handed Z-up (X right, Y depth, Z up); the game is
    // right-handed Y-up. Mapping vox(x,y,z) straight to world(x,z,y) has
    // determinant -1, i.e. a reflection, and the model comes out mirrored.
    // Flipping the depth axis (dy) restores determinant +1.
    const vol = decode(prop);
    for (let bz = 0; bz < H; bz++) {
      for (let by = 0; by < D; by++) {
        const dy = D - 1 - by;
        for (let bx = 0; bx < W; bx++) {
          const id = vol[(bz * D + by) * W + bx];
          if (!id) continue;
          let lx;
          let lz;
          if (q === 0) { lx = bx; lz = dy; }
          else if (q === 1) { lx = D - 1 - dy; lz = bx; }
          else if (q === 2) { lx = W - 1 - bx; lz = D - 1 - dy; }
          else { lx = dy; lz = W - 1 - bx; }
          const wx = ox + lx;
          const wy = gy + 1 + bz;
          const wz = oz + lz;
          if (wx < 0 || wz < 0 || wx >= size || wz >= size) continue;
          world.set(wx, wy, wz, id);
        }
      }
    }

    if (world.dirtyRect) world.dirtyRect(ox - 2, oz - 2, ox + rotW + 2, oz + rotD + 2);
    if (world.flushRebuilds) world.flushRebuilds(64, cx, cz);
    return { kind: propId, ox: ox, oz: oz, w: rotW, d: rotD, cx: cx, cz: cz, yaw: q * 90 };
  }

  global.VF.Props.stamp = stamp;
})(typeof window !== 'undefined' ? window : globalThis);
