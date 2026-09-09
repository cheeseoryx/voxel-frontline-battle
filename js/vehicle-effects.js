/**
 * vehicle-effects.js — Pooled tank cannon presentation and shot de-duplication.
 * Gameplay damage and projectile simulation remain owned by vehicles.js.
 */
(function (global) {
  'use strict';

  const MAIN_CANNON = 'tank_main_cannon';
  const SHOT_MEMORY_MS = 15000;
  const LIMITS = {
    projectile: 32,
    flash: 16,
    cone: 12,
    smoke: 72,
    dust: 48,
    spark: 96,
    debris: 48,
    ring: 16,
  };

  function nowMs() {
    return global.performance && global.performance.now
      ? global.performance.now()
      : Date.now();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function copyVec(value, fallback) {
    value = value || fallback || {};
    return {
      x: Number(value.x) || 0,
      y: Number(value.y) || 0,
      z: Number(value.z) || 0,
    };
  }

  function normalize(value) {
    const out = copyVec(value, { z: -1 });
    const length = Math.hypot(out.x, out.y, out.z) || 1;
    out.x /= length;
    out.y /= length;
    out.z /= length;
    return out;
  }

  function blastScale() {
    const def =
      global.VF &&
      global.VF.VEHICLE_WEAPONS &&
      global.VF.VEHICLE_WEAPONS[MAIN_CANNON];
    const radius = def && def.blastRadius != null ? def.blastRadius : 3.2;
    return radius / 3.2;
  }

  const VehicleEffects = {
    game: null,
    vehicles: null,
    root: null,
    _resources: null,
    _active: [],
    _pools: null,
    _created: null,
    _projectilePool: [],
    _projectileActive: [],
    _projectileCreated: 0,
    _seenShots: null,
    _seenImpacts: null,
    _barrels: [],
    _unsubscribers: [],

    init(game, vehicles) {
      this.game = game || this.game;
      vehicles = vehicles || (this.game && this.game.vehicles);
      if (!vehicles) return this;
      this._ensureState();
      this._ensureRoot();
      if (this.vehicles === vehicles && this._unsubscribers.length) return this;
      this._unbind();
      this.vehicles = vehicles;
      const self = this;
      this._unsubscribers.push(
        vehicles.on('vehicle-weapon-fired', function (event) {
          self.onWeaponFired(event && event.data);
        })
      );
      this._unsubscribers.push(
        vehicles.on('vehicle-weapon-hit', function (event) {
          self.onWeaponHit(event && event.data);
        })
      );
      this._unsubscribers.push(
        vehicles.on('vehicle-projectile-removed', function (event) {
          const data = event && event.data;
          if (data && data.shotId) self._remember(self._seenShots, self._shotKey(data));
        })
      );
      return this;
    },

    _ensureState() {
      if (!this._pools) {
        this._pools = {
          flash: [],
          cone: [],
          smoke: [],
          dust: [],
          spark: [],
          debris: [],
          ring: [],
        };
      }
      if (!this._created) {
        this._created = {
          flash: 0,
          cone: 0,
          smoke: 0,
          dust: 0,
          spark: 0,
          debris: 0,
          ring: 0,
        };
      }
      if (!this._seenShots) this._seenShots = Object.create(null);
      if (!this._seenImpacts) this._seenImpacts = Object.create(null);
    },

    _unbind() {
      for (let i = 0; i < this._unsubscribers.length; i++) {
        try {
          this._unsubscribers[i]();
        } catch (_) {}
      }
      this._unsubscribers.length = 0;
    },

    _ensureRoot() {
      const THREE = global.THREE;
      const scene = this.game && this.game.scene;
      if (!THREE || !scene) return null;
      if (!this.root) {
        this.root = new THREE.Group();
        this.root.name = 'VehicleEffects';
      }
      if (this.root.parent !== scene && scene.add) scene.add(this.root);
      if (!this._resources) {
        const cone = new THREE.ConeGeometry(0.3, 1.2, 7, 1, true);
        if (cone.rotateX) cone.rotateX(-Math.PI / 2);
        this._resources = {
          projectileCore: new THREE.BoxGeometry(0.13, 0.13, 0.34),
          projectileTrail: new THREE.BoxGeometry(0.085, 0.085, 1),
          sphere: new THREE.SphereGeometry(1, 6, 5),
          cube: new THREE.BoxGeometry(1, 1, 1),
          ring: new THREE.RingGeometry(0.42, 0.55, 18),
          cone: cone,
          projectileCoreMaterial: new THREE.MeshBasicMaterial({
            color: 0xfff2cf,
            transparent: true,
            opacity: 0.96,
          }),
          projectileTrailMaterial: new THREE.MeshBasicMaterial({
            color: 0xff8b35,
            transparent: true,
            opacity: 0.7,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
          projectileSmokeMaterial: new THREE.MeshBasicMaterial({
            color: 0x5b5650,
            transparent: true,
            opacity: 0.16,
            depthWrite: false,
          }),
        };
      }
      return this.root;
    },

    reset() {
      this._ensureState();
      for (let i = this._active.length - 1; i >= 0; i--) {
        this._releaseFxAt(i);
      }
      if (this.vehicles && this.vehicles.projectiles) {
        for (let i = 0; i < this.vehicles.projectiles.length; i++) {
          this.releaseProjectile(this.vehicles.projectiles[i]);
        }
      }
      for (let i = this._projectileActive.length - 1; i >= 0; i--) {
        const node = this._projectileActive[i];
        node.visible = false;
        node.userData.shotId = null;
        if (this._projectilePool.indexOf(node) < 0) {
          this._projectilePool.push(node);
        }
      }
      this._projectileActive.length = 0;
      for (let i = 0; i < this._barrels.length; i++) {
        const state = this._barrels[i];
        if (state.barrel && state.barrel.position) {
          state.barrel.position.z = state.restZ;
        }
      }
      this._barrels.length = 0;
      this._seenShots = Object.create(null);
      this._seenImpacts = Object.create(null);
      this._ensureRoot();
    },

    _shotKey(data) {
      return String((data && data.vehicleId) || 'none') + '|' +
        String((data && (data.shotId || data.id)) || 'none');
    },

    _remember(table, key, ttl) {
      if (!key || key.endsWith('|none')) return true;
      const now = nowMs();
      if (table[key] && table[key] > now) return false;
      table[key] = now + (ttl || SHOT_MEMORY_MS);
      return true;
    },

    _pruneMemory(table) {
      const now = nowMs();
      for (const key in table) {
        if (table[key] <= now) delete table[key];
      }
    },

    _cameraDistance(point) {
      const camera = this.game && this.game.camera;
      if (!camera || !camera.position || !point) return Infinity;
      return Math.hypot(
        camera.position.x - point.x,
        camera.position.y - point.y,
        camera.position.z - point.z
      );
    },

    _isLocalShot(data) {
      const player = this.game && this.game.player;
      if (!player || !data) return false;
      const localId =
        player.entityId != null
          ? String(player.entityId)
          : this.vehicles && this.vehicles._entityId
            ? this.vehicles._entityId(player)
            : 'player-local';
      if (data.ownerId != null && String(data.ownerId) === localId) return true;
      const def =
        global.VF &&
        global.VF.VEHICLE_WEAPONS &&
        global.VF.VEHICLE_WEAPONS[data.weaponId];
      return !!(
        player.vehicleId &&
        player.vehicleId === data.vehicleId &&
        def &&
        player.vehicleRole === def.role
      );
    },

    onWeaponFired(data) {
      if (!data || data.weaponId !== MAIN_CANNON || !data.origin) return false;
      this._ensureState();
      if (!this._remember(this._seenShots, this._shotKey(data))) return false;
      const origin = copyVec(data.origin);
      const direction = normalize(data.direction);
      this._beginBarrelRecoil(data.vehicleId);
      this._spawnMuzzle(origin, direction);
      this._playCannonAudio(origin, this._isLocalShot(data));
      const player = this.game && this.game.player;
      if (player && this._isLocalShot(data) && player.triggerVehicleCannonKick) {
        player.triggerVehicleCannonKick();
      } else {
        this._addNearbyShake(origin, 0.18);
      }
      return true;
    },

    onWeaponHit(data) {
      if (!data || data.weaponId !== MAIN_CANNON || !data.point) return false;
      return this.impact(data.shotId, data.vehicleId, 'armor', data.point, {
        normal: data.normal,
        ownerId: data.ownerId,
        sourceVehicleId: data.sourceVehicleId,
        weaponId: data.weaponId,
        damage: data.damage,
      });
    },

    _beginBarrelRecoil(vehicleId) {
      const vehicle =
        this.vehicles && this.vehicles.getById
          ? this.vehicles.getById(vehicleId)
          : null;
      const barrel = vehicle && vehicle.mesh && vehicle.mesh.userData.barrel;
      if (!barrel || !barrel.position) return;
      let state = null;
      for (let i = 0; i < this._barrels.length; i++) {
        if (this._barrels[i].barrel === barrel) {
          state = this._barrels[i];
          break;
        }
      }
      if (!state) {
        state = {
          barrel: barrel,
          restZ: barrel.position.z,
          age: 0,
          duration: 0.34,
        };
        this._barrels.push(state);
      }
      state.restZ = barrel.position.z - (state.offset || 0);
      state.age = 0;
      state.offset = 0;
    },

    _playCannonAudio(origin, local) {
      const audio = global.VF && global.VF.Audio;
      if (!audio || !audio.play) return;
      const distance = this._cameraDistance(origin);
      audio.play('vehicle.weapon.tank_cannon', {
        position: origin,
        maxDistance: 450,
        priority: 10,
        delay: !local && distance > 78 ? Math.min(0.72, distance / 343) : 0,
        gain: local ? 1.7 : 1.15,
        occupant: !!local,
      });
      audio.play('vehicle.weapon.tank_breech', {
        position: origin,
        maxDistance: 95,
        priority: 6,
        delay: 0.34,
        gain: local ? 1.05 : 0.66,
        occupant: !!local,
      });
    },

    _spawnMuzzle(origin, direction) {
      if (!this._ensureRoot()) return;
      this._spawnFx('flash', {
        x: origin.x + direction.x * 0.12,
        y: origin.y + direction.y * 0.12,
        z: origin.z + direction.z * 0.12,
      }, {
        color: 0xffe2a1,
        life: 0.065,
        opacity: 1,
        size: 0.34,
        endScale: 1.55,
      });
      this._spawnFx('cone', origin, {
        direction: direction,
        color: 0xff9c42,
        life: 0.075,
        opacity: 0.92,
        startScale: 1,
        endScale: 1.28,
      });
      for (let i = 0; i < 5; i++) {
        this._spawnFx('smoke', {
          x: origin.x + direction.x * (0.22 + i * 0.12),
          y: origin.y + direction.y * (0.22 + i * 0.12),
          z: origin.z + direction.z * (0.22 + i * 0.12),
        }, {
          color: i < 2 ? 0x4a4540 : 0x706a63,
          life: 0.8 + Math.random() * 0.4,
          opacity: 0.3,
          size: 0.22 + i * 0.055,
          endScale: 3.1,
          velocity: {
            x: direction.x * (0.8 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.7,
            y: 0.65 + Math.random() * 0.75,
            z: direction.z * (0.8 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.7,
          },
          drag: 1.6,
        });
      }
      const world = this.game && this.game.world;
      const ground =
        world && world.getTerrainTop
          ? world.getTerrainTop(origin.x, origin.z)
          : -Infinity;
      if (
        isFinite(ground) &&
        origin.y - ground < 4.5 &&
        Math.abs(direction.y) < 0.3
      ) {
        for (let i = 0; i < 6; i++) {
          const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.35;
          this._spawnFx('dust', {
            x: origin.x + direction.x * 1.1 + Math.cos(angle) * 0.5,
            y: ground + 0.12,
            z: origin.z + direction.z * 1.1 + Math.sin(angle) * 0.5,
          }, {
            color: 0x81715d,
            life: 0.65 + Math.random() * 0.35,
            opacity: 0.25,
            size: 0.24,
            endScale: 3.4,
            velocity: {
              x: Math.cos(angle) * (0.9 + Math.random()),
              y: 0.35 + Math.random() * 0.5,
              z: Math.sin(angle) * (0.9 + Math.random()),
            },
            drag: 2.2,
          });
        }
      }
    },

    _makeFx(kind) {
      const THREE = global.THREE;
      if (!THREE || !this._resources) return null;
      let geometry = this._resources.sphere;
      if (kind === 'cone') geometry = this._resources.cone;
      else if (kind === 'spark' || kind === 'debris') geometry = this._resources.cube;
      else if (kind === 'ring') geometry = this._resources.ring;
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: kind === 'spark' || kind === 'cone' || kind === 'flash'
          ? THREE.AdditiveBlending
          : THREE.NormalBlending,
        side: kind === 'ring' ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      this.root.add(mesh);
      this._created[kind]++;
      return {
        kind: kind,
        mesh: mesh,
        age: 0,
        life: 1,
        velocity: { x: 0, y: 0, z: 0 },
        drag: 0,
        gravity: 0,
        opacity: 1,
        startScale: 1,
        endScale: 1,
      };
    },

    _takeFx(kind) {
      this._ensureState();
      const pool = this._pools[kind];
      if (pool && pool.length) return pool.pop();
      if ((this._created[kind] || 0) < (LIMITS[kind] || 0)) {
        return this._makeFx(kind);
      }
      let oldest = -1;
      let oldestAge = -1;
      for (let i = 0; i < this._active.length; i++) {
        const item = this._active[i];
        if (item.kind === kind && item.age > oldestAge) {
          oldest = i;
          oldestAge = item.age;
        }
      }
      if (oldest >= 0) {
        this._releaseFxAt(oldest);
        return pool.pop() || null;
      }
      return null;
    },

    _spawnFx(kind, position, options) {
      const entry = this._takeFx(kind);
      if (!entry) return null;
      options = options || {};
      const mesh = entry.mesh;
      entry.age = 0;
      entry.life = Math.max(0.02, options.life || 1);
      entry.velocity = copyVec(options.velocity);
      entry.drag = options.drag || 0;
      entry.gravity = options.gravity || 0;
      entry.opacity = options.opacity != null ? options.opacity : 1;
      entry.startScale = options.startScale != null ? options.startScale : (options.size || 1);
      entry.endScale = options.endScale != null ? options.endScale : entry.startScale;
      mesh.visible = true;
      mesh.position.set(position.x, position.y, position.z);
      mesh.scale.set(entry.startScale, entry.startScale, entry.startScale);
      if (mesh.material.color && mesh.material.color.setHex) {
        mesh.material.color.setHex(options.color != null ? options.color : 0xffffff);
      }
      mesh.material.opacity = entry.opacity;
      mesh.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      );
      if ((kind === 'cone' || kind === 'ring') && options.direction && mesh.lookAt) {
        const dir = normalize(options.direction);
        mesh.lookAt(
          position.x + dir.x,
          position.y + dir.y,
          position.z + dir.z
        );
      }
      this._active.push(entry);
      return entry;
    },

    _releaseFxAt(index) {
      const entry = this._active[index];
      if (!entry) return;
      this._active.splice(index, 1);
      entry.mesh.visible = false;
      this._pools[entry.kind].push(entry);
    },

    _makeProjectileNode() {
      const THREE = global.THREE;
      if (!THREE || !this._ensureRoot()) return null;
      const node = new THREE.Group();
      const core = new THREE.Mesh(
        this._resources.projectileCore,
        this._resources.projectileCoreMaterial
      );
      const trail = new THREE.Mesh(
        this._resources.projectileTrail,
        this._resources.projectileTrailMaterial
      );
      const smoke = new THREE.Mesh(
        this._resources.projectileTrail,
        this._resources.projectileSmokeMaterial
      );
      const light = new THREE.PointLight(0xff7b35, 2.3, 10, 2);
      trail.position.z = 0.8;
      smoke.position.z = 1.2;
      node.add(core);
      node.add(trail);
      node.add(smoke);
      node.add(light);
      node.userData.core = core;
      node.userData.trail = trail;
      node.userData.smoke = smoke;
      node.userData.light = light;
      node.visible = false;
      this.root.add(node);
      this._projectileCreated++;
      return node;
    },

    _takeProjectileNode() {
      if (this._projectilePool.length) return this._projectilePool.pop();
      if (this._projectileCreated < LIMITS.projectile) {
        return this._makeProjectileNode();
      }
      return null;
    },

    updateProjectile(projectile, dt) {
      if (!projectile || projectile.weaponId !== MAIN_CANNON) return false;
      this._ensureState();
      if (projectile.remote && !projectile._vehicleFxRemoteAnnounced) {
        projectile._vehicleFxRemoteAnnounced = true;
        const data = {
          shotId: projectile.id,
          vehicleId: projectile.vehicleId,
          ownerId: projectile.ownerId,
          weaponId: projectile.weaponId,
          origin: projectile.position,
          direction: projectile.direction,
        };
        if (this._isLocalShot(data)) {
          this._remember(this._seenShots, this._shotKey(data));
        } else {
          const vehicle =
            this.vehicles && this.vehicles.getById
              ? this.vehicles.getById(projectile.vehicleId)
              : null;
          const def =
            global.VF &&
            global.VF.VEHICLE_WEAPONS &&
            global.VF.VEHICLE_WEAPONS[projectile.weaponId];
          if (vehicle && def && this.vehicles._shotOrigin) {
            data.origin = this.vehicles._shotOrigin(vehicle, def, {});
          }
          this.onWeaponFired(data);
        }
      }
      if (!projectile.mesh) {
        projectile.mesh = this._takeProjectileNode();
        if (!projectile.mesh) return true;
        projectile.mesh.visible = true;
        projectile.mesh.userData.shotId = projectile.id;
        this._projectileActive.push(projectile.mesh);
      }
      const node = projectile.mesh;
      const p = projectile.position;
      const d = normalize(projectile.direction);
      node.position.set(p.x, p.y, p.z);
      if (node.lookAt) node.lookAt(p.x + d.x, p.y + d.y, p.z + d.z);
      const previous = projectile.previousPosition || p;
      const moved = Math.hypot(
        p.x - previous.x,
        p.y - previous.y,
        p.z - previous.z
      );
      const trailLength = clamp(Math.max(moved, (projectile.speed || 0) * (dt || 0)), 0.65, 3.2);
      const trail = node.userData.trail;
      const smoke = node.userData.smoke;
      trail.scale.set(1, 1, trailLength);
      trail.position.z = 0.22 + trailLength * 0.5;
      smoke.scale.set(1.5, 1.5, trailLength * 1.35);
      smoke.position.z = 0.35 + trailLength * 0.68;
      const distance = this._cameraDistance(p);
      node.userData.core.visible = distance >= 1.8;
      trail.visible = distance >= 2.5;
      smoke.visible = distance >= 3.2;
      node.userData.light.visible = distance >= 3 && distance < 85;
      return true;
    },

    releaseProjectile(projectile) {
      if (!projectile || !projectile.mesh) return false;
      const node = projectile.mesh;
      if (node.userData && node.userData.shotId != null) {
        node.visible = false;
        node.userData.shotId = null;
        const activeIndex = this._projectileActive.indexOf(node);
        if (activeIndex >= 0) this._projectileActive.splice(activeIndex, 1);
        if (this._projectilePool.indexOf(node) < 0) {
          this._projectilePool.push(node);
        }
      } else {
        return false;
      }
      projectile.mesh = null;
      return true;
    },

    impactProjectile(projectile, kind, options) {
      if (!projectile || projectile.weaponId !== MAIN_CANNON) return false;
      options = options || {};
      return this.impact(
        projectile.id,
        options.targetVehicleId || projectile.vehicleId,
        kind,
        options.point || projectile.position,
        {
          normal: options.normal,
          color: options.color,
          ownerId: projectile.ownerId,
          sourceVehicleId: projectile.vehicleId,
          weaponId: projectile.weaponId,
          damage: options.damage != null ? options.damage : projectile.damage,
          localPredicted: !!projectile.predictOnly && !projectile.remote,
        }
      );
    },

    impact(shotId, targetVehicleId, kind, point, options) {
      if (!point) return false;
      this._ensureState();
      const impactData = {
        shotId: shotId,
        vehicleId: targetVehicleId,
      };
      if (!this._remember(this._seenImpacts, this._shotKey(impactData))) return false;
      options = options || {};
      const normal = normalize(options.normal || { x: 0, y: 1, z: 0 });
      const color = options.color != null ? options.color : 0x81715d;
      if (kind === 'armor') {
        this._spawnFx('flash', point, {
          color: 0xffe0a3,
          life: 0.08,
          opacity: 1,
          size: 0.28,
          endScale: 1.8,
        });
        for (let i = 0; i < 12; i++) {
          const spread = 0.55;
          this._spawnFx(i < 8 ? 'spark' : 'debris', point, {
            color: i < 8 ? 0xffb05a : 0x3b3834,
            life: 0.3 + Math.random() * 0.35,
            opacity: 0.95,
            size: i < 8 ? 0.035 : 0.075,
            endScale: i < 8 ? 0.25 : 0.7,
            velocity: {
              x: normal.x * (2.2 + Math.random() * 4) + (Math.random() - 0.5) * spread * 5,
              y: normal.y * (2.2 + Math.random() * 3) + Math.random() * 2.4,
              z: normal.z * (2.2 + Math.random() * 4) + (Math.random() - 0.5) * spread * 5,
            },
            drag: 1.4,
            gravity: -7,
          });
        }
        if (global.VF && global.VF.Audio) {
          global.VF.Audio.play('vehicle.impact.armor', {
            position: point,
            maxDistance: 300,
            priority: 7,
          });
        }
        const localData = {
          vehicleId: options.sourceVehicleId,
          ownerId: options.ownerId,
          weaponId: options.weaponId || MAIN_CANNON,
        };
        if (
          (this._isLocalShot(localData) || options.localPredicted) &&
          global.VF &&
          global.VF.UI &&
          global.VF.UI.flashVehicleHit
        ) {
          global.VF.UI.flashVehicleHit(options.damage || 0);
        }
      } else if (kind === 'infantry') {
        this._spawnFx('flash', point, {
          color: 0xff9b68,
          life: 0.07,
          opacity: 0.9,
          size: 0.18,
          endScale: 1.25,
        });
        for (let i = 0; i < 6; i++) {
          this._spawnFx('spark', point, {
            color: i % 2 ? 0xb84f32 : 0xffa06e,
            life: 0.18 + Math.random() * 0.2,
            opacity: 0.72,
            size: 0.025,
            endScale: 0.2,
            velocity: {
              x: (Math.random() - 0.5) * 3.2,
              y: 0.8 + Math.random() * 2.4,
              z: (Math.random() - 0.5) * 3.2,
            },
            drag: 2.2,
            gravity: -5,
          });
        }
        if (
          global.VF &&
          global.VF.Audio &&
          this._cameraDistance(point) < 180
        ) {
          global.VF.Audio.play('hit_heavy');
        }
      } else {
        const structure = kind === 'structure';
        const boom = blastScale();
        this._spawnFx('ring', point, {
          direction: normal,
          color: structure ? 0xc5aa86 : 0xffb15c,
          life: 0.42,
          opacity: 0.72,
          startScale: 0.8 * boom,
          endScale: (structure ? 5.2 : 6.4) * boom,
        });
        for (let i = 0; i < 8; i++) {
          const angle = Math.random() * Math.PI * 2;
          this._spawnFx('debris', point, {
            color: structure ? color : (i % 2 ? 0x655444 : 0x8b755b),
            life: 0.6 + Math.random() * 0.55,
            opacity: 0.95,
            size: 0.07 + Math.random() * 0.07,
            endScale: 0.65,
            velocity: {
              x: Math.cos(angle) * (1.5 + Math.random() * 4),
              y: 2.2 + Math.random() * 4.2,
              z: Math.sin(angle) * (1.5 + Math.random() * 4),
            },
            drag: 0.8,
            gravity: -8.5,
          });
        }
        if (global.VF && global.VF.Audio) {
          global.VF.Audio.play(
            structure ? 'vehicle.impact.structure' : 'vehicle.impact.ground',
            { position: point, maxDistance: 330, priority: 7 }
          );
        }
      }
      if (global.VF && global.VF.Audio && global.VF.Audio.playExplosionAt) {
        global.VF.Audio.playExplosionAt(point, 'cannon', {
          gain: kind === 'infantry' ? 1.35 : 1.7,
        });
      }
      const boom = kind === 'armor' || kind === 'infantry' ? 1 : blastScale();
      const smokeCount = kind === 'infantry' ? 3 : 7;
      for (let i = 0; i < smokeCount; i++) {
        this._spawnFx(
          kind === 'infantry' ? 'smoke' : i < 2 ? 'dust' : 'smoke',
          {
          x: point.x + (Math.random() - 0.5) * 0.65 * boom,
          y: point.y + Math.random() * 0.28 * boom,
          z: point.z + (Math.random() - 0.5) * 0.65 * boom,
          },
          {
            color:
              kind === 'armor'
                ? 0x504b46
                : kind === 'infantry'
                  ? 0x5d463d
                  : color,
            life:
              (kind === 'infantry' ? 0.35 : 1.2) +
              Math.random() * (kind === 'infantry' ? 0.25 : 0.6),
            opacity: kind === 'armor' ? 0.24 : kind === 'infantry' ? 0.16 : 0.32,
            size:
              ((kind === 'infantry' ? 0.08 : 0.2) +
                Math.random() * (kind === 'infantry' ? 0.06 : 0.18)) *
              boom,
            endScale:
              ((kind === 'infantry' ? 1.8 : 3.8) +
                Math.random() * (kind === 'infantry' ? 0.5 : 1.6)) *
              boom,
            velocity: {
              x: (Math.random() - 0.5) * 1.1,
              y: 0.75 + Math.random() * 1.5,
              z: (Math.random() - 0.5) * 1.1,
            },
            drag: 1.1,
          }
        );
      }
      this._addNearbyShake(
        point,
        (kind === 'armor' ? 0.2 : kind === 'infantry' ? 0.16 : 0.28) *
          (kind === 'armor' || kind === 'infantry' ? 1 : boom)
      );
      return true;
    },

    _addNearbyShake(point, strength) {
      const player = this.game && this.game.player;
      const pos = player && player.object && player.object.position;
      if (!player || !pos) return;
      const distance = Math.hypot(
        pos.x - point.x,
        pos.y - point.y,
        pos.z - point.z
      );
      if (distance >= 32) return;
      const amount = strength * (1 - distance / 32);
      if (player.vehicleId && player.addVehicleBlastShake) {
        player.addVehicleBlastShake(amount);
      } else if (player.addShake) {
        player.addShake(amount);
      }
    },

    update(dt) {
      dt = Math.max(0, Number(dt) || 0);
      this._ensureState();
      for (let i = this._barrels.length - 1; i >= 0; i--) {
        const state = this._barrels[i];
        if (!state.barrel || !state.barrel.position || !state.barrel.parent) {
          this._barrels.splice(i, 1);
          continue;
        }
        state.age += dt;
        let amount = 0;
        if (state.age < 0.075) {
          const t = state.age / 0.075;
          amount = 0.3 * (1 - Math.pow(1 - t, 3));
        } else {
          const t = clamp((state.age - 0.075) / 0.255, 0, 1);
          amount = 0.3 * Math.pow(1 - t, 2) * Math.cos(t * Math.PI * 1.4);
        }
        state.offset = amount;
        state.barrel.position.z = state.restZ + amount;
        if (state.age >= state.duration) {
          state.barrel.position.z = state.restZ;
          this._barrels.splice(i, 1);
        }
      }
      for (let i = this._active.length - 1; i >= 0; i--) {
        const entry = this._active[i];
        entry.age += dt;
        if (entry.age >= entry.life) {
          this._releaseFxAt(i);
          continue;
        }
        const t = clamp(entry.age / entry.life, 0, 1);
        const mesh = entry.mesh;
        mesh.position.x += entry.velocity.x * dt;
        mesh.position.y += entry.velocity.y * dt;
        mesh.position.z += entry.velocity.z * dt;
        entry.velocity.y += entry.gravity * dt;
        const damping = Math.exp(-entry.drag * dt);
        entry.velocity.x *= damping;
        entry.velocity.y *= damping;
        entry.velocity.z *= damping;
        const scale = entry.startScale + (entry.endScale - entry.startScale) * t;
        mesh.scale.set(scale, scale, scale);
        mesh.material.opacity = entry.opacity * Math.pow(1 - t, entry.kind === 'spark' ? 0.35 : 1.35);
        if (entry.kind === 'debris' || entry.kind === 'spark') {
          mesh.rotation.x += dt * 7;
          mesh.rotation.y += dt * 9;
        }
      }
      this._pruneMemory(this._seenShots);
      this._pruneMemory(this._seenImpacts);
    },

    getStats() {
      this._ensureState();
      const pooled = {};
      for (const kind in this._pools) pooled[kind] = this._pools[kind].length;
      return {
        activeEffects: this._active.length,
        activeProjectiles: this._projectileActive.length,
        projectileCreated: this._projectileCreated,
        sharedGeometries: this._resources ? 6 : 0,
        sharedProjectileMaterials: this._resources ? 3 : 0,
        created: Object.assign({}, this._created),
        pooled: pooled,
        limits: Object.assign({}, LIMITS),
      };
    },
  };

  global.VF = global.VF || {};
  global.VF.VehicleEffects = VehicleEffects;
})(typeof window !== 'undefined' ? window : this);
