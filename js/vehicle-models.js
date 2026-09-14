/**
 * vehicle-models.js — GLB vehicle models (assets/vehicles/*.glb).
 *
 * Replaces the procedural box models in vehicles.js with the authored art.
 * Kept in its own file on purpose: scripts/check-vehicles.js runs vehicles.js
 * through vm.runInNewContext with THREE absent, so none of this may leak into
 * that path. vehicles.js only ever reaches us through an optional-chained
 * VF.VehicleModels lookup and falls back to its procedural builder.
 *
 * The GLBs are UE5 exports: one node, one mesh, one material, no animations
 * and no skeleton — so there are no turret/barrel nodes to articulate. build()
 * publishes nulls for all four rig slots; every consumer already null-guards
 * (vehicles.js _syncVisual, vehicle-effects.js barrel recoil).
 */
(function (global) {
  'use strict';

  // Per-type knobs. yawOffset corrects authoring direction: the game's forward
  // is -Z (see forwardFor in vehicles.js), but all three UE exports face +Z,
  // so each needs a half turn. Verified in game, not inferred from geometry —
  // an earlier guess based on "which end does the thin part stick out of" only
  // held for the tank's gun barrel and got the jeep and IFV backwards.
  //
  // scaleMode:
  //   'fit'     — per-axis scale so the model matches def.dimensions exactly.
  //               Visual silhouette agrees with the collision box at the cost
  //               of distorting the model (the tank loses ~19% of its length).
  //   'uniform' — single factor from the length axis; keeps proportions but
  //               lets height overhang the collision box.
  const GLB_CONFIG = {
    jeep: { url: 'assets/vehicles/jeep.glb?v=veh1', yawOffset: Math.PI, scaleMode: 'fit' },
    ifv: { url: 'assets/vehicles/ifv.glb?v=veh1', yawOffset: Math.PI, scaleMode: 'fit' },
    tank: { url: 'assets/vehicles/tank.glb?v=veh1', yawOffset: Math.PI, scaleMode: 'fit' },
  };

  // material.color multiplies the texture, so a saturated team colour would
  // destroy the camo artwork. Lerp the HUD colours toward white and use that
  // as a wash. Note the ceiling here: the camo texture itself sits around
  // 60-90 luma, so a wash alone can only ever produce a ~25-30 RGB separation
  // between teams — invisible at range. The marker stripes below do the actual
  // identification work, so keep this subtle enough that the camo survives.
  const TEAM_TINT_STRENGTH = 0.3;
  const TEAM_BASE = { friend: 0x3d8fbd, foe: 0xb43f36 };

  // Marker stripes. Lambert, not Basic: they shade with the scene like the
  // hull instead of glowing, which is what actually sells them as paint. The
  // trade-off is that back-lit faces go dim, so these are a notch brighter
  // than the HUD colours to compensate. Named 'TeamMark' to match the
  // convention the procedural models and refreshDisplayColors already use.
  const TEAM_MARK = { friend: 0x4db8ff, foe: 0xff4d5c };

  // Marker geometry, as fractions of def.dimensions. Long and thin so they
  // read as a sprayed stripe. The stripe *height* and its lateral/tail offset
  // are measured off the baked mesh (see measureSurface); only the footprint
  // size is fixed here.
  const MARK_THICK_Y = 0.07; // stripe height
  const MARK_LEN_Z = 0.3; // flank stripe length, fraction of vehicle length
  const MARK_Z = 0.2; // flank stripe centre, fraction of length (+Z = tail)
  const MARK_REAR_W = 0.26; // rear stripe width, fraction of vehicle width
  const MARK_FRONT_W = 0.26; // front stripe width, fraction of vehicle width
  // How far the outer face clears the hull's measured high point. This is a
  // tolerance, not a visual gap: on a sloped face (the tank's glacis) even the
  // fine grid under-reads the true peak by a few mm, and any under-read eats a
  // strip of the marker. Cheaper than sampling finer, and invisible at 1cm on
  // a 7m hull. Must stay below MARK_SLAB_MIN or the slab starts to float.
  const MARK_PROUD = 0.014;
  const MARK_SLAB_MIN = 0.04; // slab thickness floor, metres
  const MARK_SLAB_MAX = 0.3; // guard against a wild probe result

  // Candidate stripe heights, as fractions of vehicle height. measureSurface
  // picks whichever one lies against the flattest run of hull, independently
  // for each face. The upper bands matter for the nose: the jeep's flat nose
  // is at 0.28H, the IFV's at 0.40H and the tank's sloped glacis at 0.32H.
  const MARK_BANDS = [0.2, 0.24, 0.28, 0.32, 0.36, 0.4, 0.44, 0.48];

  // Two bands counting as equally flat (metres of spread). Within this, prefer
  // whichever sits further out — it is the more visible surface. Without the
  // tie-break the tank's nose stripe landed 23cm back down its glacis.
  const MARK_FLAT_EPS = 0.005;

  function tint(hex) {
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    const mix = function (c) {
      return Math.round(255 + (c - 255) * TEAM_TINT_STRENGTH);
    };
    return (mix(r) << 16) | (mix(g) << 8) | mix(b);
  }

  const TEAM_TINT = { friend: tint(TEAM_BASE.friend), foe: tint(TEAM_BASE.foe) };

  // type -> { geometry, materials: { friend, foe } }
  const CACHE = Object.create(null);
  let loadPromise = null;
  let warned = false;

  function teamKind(team) {
    const L = global.VF && global.VF.TeamLook;
    if (L && typeof L.kind === 'function') return L.kind(team) === 'foe' ? 'foe' : 'friend';
    return team === 'enemy' ? 'foe' : 'friend';
  }

  function warnOnce(message, detail) {
    if (warned) return;
    warned = true;
    // file:// treats every file as an opaque origin, so fetch() (which
    // GLTFLoader uses) is rejected outright with "Failed to fetch" while
    // <script src> keeps working. That combination is confusing enough to
    // call out by name rather than leaving a bare network error.
    if (global.location && global.location.protocol === 'file:') {
      console.warn(
        '[VehicleModels] 检测到用 file:// 直接打开页面，浏览器安全策略禁止读取 ' +
          'assets/vehicles/*.glb，载具回退到程序化模型。' +
          '请改用「启动游戏.cmd」通过 http://127.0.0.1:8765/ 打开。',
        detail || ''
      );
      return;
    }
    console.warn('[VehicleModels] ' + message + '；回退到程序化载具模型', detail || '');
  }

  function firstMesh(scene) {
    let found = null;
    scene.traverse(function (child) {
      if (!found && child.isMesh && child.geometry) found = child;
    });
    return found;
  }

  /**
   * Bake orientation, scale and ground alignment straight into the geometry.
   *
   * This cannot live on the mesh transform: _syncVisual overwrites the root's
   * position and all three Euler angles every frame, so anything set there is
   * clobbered. Baking is also a one-time cost with no per-frame overhead.
   */
  function bakeGeometry(THREE, geometry, def, config) {
    const geo = geometry.clone();
    if (config.yawOffset) geo.rotateY(config.yawOffset);

    geo.computeBoundingBox();
    let box = geo.boundingBox;
    const dims = def.dimensions || {};
    const sizeX = box.max.x - box.min.x;
    const sizeY = box.max.y - box.min.y;
    const sizeZ = box.max.z - box.min.z;

    if (sizeX > 1e-6 && sizeY > 1e-6 && sizeZ > 1e-6) {
      const fx = (dims.width || sizeX) / sizeX;
      const fy = (dims.height || sizeY) / sizeY;
      const fz = (dims.length || sizeZ) / sizeZ;
      if (config.scaleMode === 'uniform') {
        geo.scale(fz, fz, fz);
      } else {
        geo.scale(fx, fy, fz);
      }
      geo.computeBoundingBox();
      box = geo.boundingBox;
    }

    // Vehicle origin sits on the ground plane; re-seat after scaling and
    // re-centre laterally so the art lines up with the analytic AABB.
    geo.translate(
      -(box.max.x + box.min.x) / 2,
      -box.min.y,
      -(box.max.z + box.min.z) / 2
    );
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * Choose where each team stripe sits by probing the baked hull.
   *
   * The stripes used to be placed at fixed fractions of def.dimensions, which
   * floated: the hulls have very different cross-sections. Probed half-width
   * at the old stripe height (jeep / ifv / tank):
   *
   *   half-width from dimensions:  1.175 / 1.625 / 1.825
   *   actual hull surface there:   0.982 / 1.383 / 1.825
   *
   * The jeep and IFV tuck in above the wheel arches while the tank is at its
   * widest, so no fraction fits all three. Worse, no single *height* works
   * either — at 0.45H the jeep flank is flat to within 1cm but the tank is
   * beside its turret, where the hull has fallen away by 0.7m. So we probe a
   * few candidate heights and keep the one lying against the flattest run of
   * hull, independently for each of the four faces.
   *
   * Rays, not vertex sampling: a large flat hull panel carries vertices only
   * at its corners, so scanning for vertices inside a thin y-band finds
   * nothing across most of a flat flank (the jeep filled 1 of 8 slices) and
   * the answer rides on whichever stray vertex landed in range.
   *
   * Offsets are the footprint's *outermost* hit, so the slab clears the hull
   * everywhere and stays fully visible. Taking the innermost instead buried
   * it — the jeep's tail bulges 0.28m past its flattest point.
   *
   * Returns null if nothing was hit, and the caller falls back to fractions.
   */
  function measureSurface(THREE, geometry, def) {
    if (!THREE.Raycaster || !THREE.Mesh) return null;
    const d = (def && def.dimensions) || {};
    const w = d.width || 2.4;
    const h = d.height || 2;
    const l = d.length || 4.8;

    const probe = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    probe.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    // Start outside the bounding box and march inward; the first front face
    // we meet is the outer skin.
    const START = Math.max(w, l) * 2;
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();

    const cast = function (ox, oy, oz, dx, dy, dz) {
      origin.set(ox, oy, oz);
      dir.set(dx, dy, dz);
      ray.set(origin, dir);
      const hits = ray.intersectObject(probe, false);
      return hits.length ? hits[0].point : null;
    };

    // Sampling density across the stripe footprint. Two passes: a coarse grid
    // to rank the candidate bands, then a fine grid on the winner only. Dense
    // sampling matters — a coarse grid misses local high spots and leaves the
    // slab partly swallowed (9x3 was off by 2.4cm) — but spending it on all
    // six bands tripled load time for a result five of them never use.
    const COARSE_SAMPLES = 9;
    const COARSE_ROWS = [-0.5, 0, 0.5];
    const FINE_SAMPLES = 17;
    const FINE_ROWS = [-0.5, -0.25, 0, 0.25, 0.5];

    // Probe one candidate band, returning how far out the hull reaches, how
    // uneven it is across the footprint, and how much of it we actually hit.
    const probeBand = function (centreY, project, samples, rows) {
      let outer = -Infinity;
      let inner = Infinity;
      let hits = 0;
      let total = 0;
      for (let r = 0; r < rows.length; r++) {
        const y = centreY + rows[r] * MARK_THICK_Y * h;
        for (let s = 0; s < samples; s++) {
          total++;
          const t = samples === 1 ? 0.5 : s / (samples - 1);
          const value = project(y, t);
          if (value === null) continue;
          hits++;
          if (value > outer) outer = value;
          if (value < inner) inner = value;
        }
      }
      if (!hits) return null;
      return {
        centreY: centreY,
        outer: outer,
        spread: outer - inner,
        coverage: hits / total,
      };
    };

    // Prefer a band we hit everywhere; among those, the flattest; among
    // equally flat ones, the one furthest out (see MARK_FLAT_EPS).
    const best = function (bands) {
      let pick = null;
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        if (!b) continue;
        if (!pick) {
          pick = b;
          continue;
        }
        const full = b.coverage > 0.999;
        const pickFull = pick.coverage > 0.999;
        if (full !== pickFull) {
          if (full) pick = b;
          continue;
        }
        if (b.coverage > pick.coverage + 0.05) {
          pick = b;
          continue;
        }
        if (pick.coverage > b.coverage + 0.05) continue;
        if (Math.abs(b.spread - pick.spread) <= MARK_FLAT_EPS) {
          if (b.outer > pick.outer) pick = b;
        } else if (b.spread < pick.spread) {
          pick = b;
        }
      }
      return pick;
    };

    // Rank candidate bands on the coarse grid, then re-probe only the winner
    // at full density to get an offset and spread we can trust.
    const solve = function (project) {
      const pick = best(
        MARK_BANDS.map(function (yf) {
          return probeBand(yf * h, project, COARSE_SAMPLES, COARSE_ROWS);
        })
      );
      if (!pick) return null;
      const refined =
        probeBand(pick.centreY, project, FINE_SAMPLES, FINE_ROWS) || pick;
      return { offset: refined.outer, y: refined.centreY, spread: refined.spread };
    };

    const zMid = MARK_Z * l;
    const zHalf = (MARK_LEN_Z * l) / 2;
    // Probe each flank separately rather than mirroring: the IFV hull is not
    // laterally symmetric, and assuming it left the -X stripe 2cm sunk in.
    const flankRight = solve(function (y, t) {
      const z = zMid - zHalf + 2 * zHalf * t;
      const hit = cast(START, y, z, -1, 0, 0);
      return hit ? hit.x : null;
    });
    const flankLeft = solve(function (y, t) {
      const z = zMid - zHalf + 2 * zHalf * t;
      const hit = cast(-START, y, z, 1, 0, 0);
      return hit ? -hit.x : null;
    });

    const xHalf = (MARK_REAR_W * w) / 2;
    const rear = solve(function (y, t) {
      const x = -xHalf + 2 * xHalf * t;
      const hit = cast(x, y, START, 0, 0, -1);
      return hit ? hit.z : null;
    });

    // Nose. Sign-flipped so "outer" still means "further from the centre",
    // which keeps best()'s flat/outermost tie-break pointing the right way.
    //
    // The gun barrel is the trap here: on the tank it reaches z=-3.625 at
    // 0.52H, 1.5m clear of the hull, and a stripe pinned to it would hang in
    // mid-air. The flattest-band rule rejects it on its own — across the
    // stripe's width that band varies by 3.2m, versus a millimetre on the
    // glacis — so no barrel-specific special case is needed.
    const xHalfFront = (MARK_FRONT_W * w) / 2;
    const front = solve(function (y, t) {
      const x = -xHalfFront + 2 * xHalfFront * t;
      const hit = cast(x, y, -START, 0, 0, 1);
      return hit ? -hit.z : null;
    });

    if (!flankRight && !flankLeft && !rear && !front) return null;
    return {
      flankRight: flankRight,
      flankLeft: flankLeft,
      rear: rear,
      front: front,
    };
  }

  function buildMaterials(THREE, source) {
    // The scene is lit by ambient + directional with no envmap and shadows
    // disabled (main.js), and everything else uses MeshLambertMaterial
    // (cachedMaterial in vehicles.js). The GLB's MeshStandardMaterial reads
    // dark and flat here, so convert and keep only the base colour map.
    const map = source && source.map ? source.map : null;
    const out = {};
    ['friend', 'foe'].forEach(function (kind) {
      out[kind] = new THREE.MeshLambertMaterial({
        map: map,
        color: TEAM_TINT[kind],
      });
    });
    return out;
  }

  // Shared marker materials, one per team kind. Built lazily so THREE is
  // guaranteed to exist, and shared across every vehicle so switching teams is
  // a material swap rather than an allocation.
  const MARK_MATERIALS = Object.create(null);

  function markMaterial(THREE, kind) {
    if (!MARK_MATERIALS[kind]) {
      MARK_MATERIALS[kind] = new THREE.MeshLambertMaterial({ color: TEAM_MARK[kind] });
    }
    return MARK_MATERIALS[kind];
  }

  /**
   * Add flat team-colour stripes to a vehicle root.
   *
   * Four stripes: both flanks, the tail and the nose. The nose one exists
   * because head-on the flank stripes are edge-on and the tail is hidden, so
   * an approaching vehicle had no team cue at all.
   *
   * Heights and offsets come from `surface` (probed off the baked mesh) so
   * each stripe lies against real hull; the fractions are only a fallback for
   * when probing found nothing.
   *
   * A flat slab cannot be flush everywhere against a curved hull — the IFV
   * tail alone varies 6cm across the stripe's footprint. So each slab is made
   * thick enough to span its own measured spread and then pushed out until
   * only the outer face shows: the far side is buried in hull rather than
   * hanging in air, which is what reads as paint.
   *
   * Deliberately no roof stripe: the hulls taper toward their bounding-box top
   * (turret and antennae account for the upper third), so anything pinned near
   * full height visibly floats above the tank and IFV.
   */
  function addTeamMarks(THREE, root, def, kind, surface) {
    const d = (def && def.dimensions) || {};
    const w = d.width || 2.4;
    const h = d.height || 2;
    const l = d.length || 4.8;
    const mat = markMaterial(THREE, kind);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const s = surface || {};
    const thickY = MARK_THICK_Y * h;

    const num = function (value, fallback) {
      return typeof value === 'number' && isFinite(value) ? value : fallback;
    };

    // Resolve one probed face into a slab thickness and a centre offset such
    // that the outer face sits MARK_PROUD beyond the hull's high point. The
    // offset returned is a magnitude; the caller applies the sign.
    const plan = function (face, fallbackOffset) {
      const offset = num(face && face.offset, fallbackOffset);
      const spread = num(face && face.spread, 0);
      let thick = spread + MARK_SLAB_MIN;
      if (thick > MARK_SLAB_MAX) thick = MARK_SLAB_MAX;
      return {
        thick: thick,
        centre: offset + MARK_PROUD - thick / 2,
        y: num(face && face.y, 0.4 * h),
      };
    };

    const right = plan(s.flankRight, w * 0.48);
    const left = plan(s.flankLeft, w * 0.48);
    const rear = plan(s.rear, l * 0.47);
    const front = plan(s.front, l * 0.47);

    // [sx, sy, sz, x, y, z]
    const stripes = [
      [right.thick, thickY, MARK_LEN_Z * l, right.centre, right.y, MARK_Z * l],
      [left.thick, thickY, MARK_LEN_Z * l, -left.centre, left.y, MARK_Z * l],
      [MARK_REAR_W * w, thickY, rear.thick, 0, rear.y, rear.centre],
      [MARK_FRONT_W * w, thickY, front.thick, 0, front.y, -front.centre],
    ];

    stripes.forEach(function (p) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(p[0], p[1], p[2]);
      mesh.position.set(p[3], p[4], p[5]);
      mesh.name = 'TeamMark';
      mesh.userData.teamMark = true;
      root.add(mesh);
    });
  }

  function loadOne(THREE, type) {
    const config = GLB_CONFIG[type];
    const def = global.VF && global.VF.VEHICLE_DEFS && global.VF.VEHICLE_DEFS[type];
    if (!config || !def) return Promise.resolve(null);
    return new Promise(function (resolve) {
      const loader = new THREE.GLTFLoader();
      loader.load(
        config.url,
        function (gltf) {
          try {
            const mesh = gltf && gltf.scene ? firstMesh(gltf.scene) : null;
            if (!mesh) {
              warnOnce(type + ' 模型中没有找到网格');
              resolve(null);
              return;
            }
            const baked = bakeGeometry(THREE, mesh.geometry, def, config);
            CACHE[type] = {
              geometry: baked,
              materials: buildMaterials(THREE, mesh.material),
              surface: measureSurface(THREE, baked, def),
            };
            resolve(CACHE[type]);
          } catch (error) {
            warnOnce(type + ' 模型处理失败', error);
            resolve(null);
          }
        },
        undefined,
        function (error) {
          warnOnce(type + ' 模型加载失败', error);
          resolve(null);
        }
      );
    });
  }

  const VehicleModels = {
    /**
     * Fetch and bake all vehicle GLBs. Single-flight and error-tolerant: a
     * failed type simply keeps its procedural model. Resolves to the number of
     * types that loaded.
     */
    preload: function () {
      if (loadPromise) return loadPromise;
      const THREE = global.THREE;
      if (!THREE || !THREE.GLTFLoader) {
        warnOnce('GLTFLoader 不可用（需要重新构建 three bundle）');
        loadPromise = Promise.resolve(0);
        return loadPromise;
      }
      const types = Object.keys(GLB_CONFIG);
      loadPromise = Promise.all(
        types.map(function (type) {
          return loadOne(THREE, type).catch(function () {
            return null;
          });
        })
      ).then(function (results) {
        return results.filter(Boolean).length;
      });
      return loadPromise;
    },

    /** True once this type's GLB is baked and ready. */
    has: function (type) {
      return !!CACHE[type];
    },

    /** Shared tinted material for a (type, team) pair, or null. */
    materialFor: function (type, team) {
      const entry = CACHE[type];
      return entry ? entry.materials[teamKind(team)] : null;
    },

    /** Shared unlit marker material for a team, or null before THREE exists. */
    markMaterialFor: function (team) {
      const THREE = global.THREE;
      return THREE ? markMaterial(THREE, teamKind(team)) : null;
    },

    /**
     * Build a vehicle root from the baked GLB, matching the contract that
     * vehicles.js createVehicleModel publishes. Returns null before preload
     * finishes so the caller falls back to the procedural builder.
     */
    build: function (type, team) {
      const THREE = global.THREE;
      const entry = CACHE[type];
      if (!THREE || !entry) return null;

      const root = new THREE.Group();
      root.name = 'Vehicle_' + type;

      const mesh = new THREE.Mesh(entry.geometry, entry.materials[teamKind(team)]);
      mesh.name = 'Body';
      // Shadows are globally off (main.js), but stay consistent with the
      // procedural path in case they are ever switched on.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Marks this mesh for refreshDisplayColors, which swaps the whole
      // material instead of tinting a TeamMark sub-mesh.
      mesh.userData.vehicleTint = true;
      root.add(mesh);

      const def = global.VF && global.VF.VEHICLE_DEFS && global.VF.VEHICLE_DEFS[type];
      addTeamMarks(THREE, root, def, teamKind(team), entry.surface);

      root.userData = root.userData || {};
      root.userData.vehicleType = type;
      root.userData.glbModel = true;
      // Single-mesh art: no articulated turret or barrel. Every consumer
      // null-guards these, so rotation and recoil simply no-op.
      root.userData.turret = null;
      root.userData.barrel = null;
      root.userData.gunnerTurret = null;
      root.userData.gunnerBarrel = null;
      return root;
    },
  };

  global.VF = global.VF || {};
  global.VF.VehicleModels = VehicleModels;
})(typeof window !== 'undefined' ? window : globalThis);
