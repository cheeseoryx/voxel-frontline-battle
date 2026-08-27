/**
 * atmosphere.js — Tiny opaque cube dust motes (solid, ~1/8 prior mote size).
 * No soft fog spheres / translucent puffs.
 */
(function (global) {
  'use strict';

  const MOTE_COUNT = 216; // was 144; +50% floating red cubes
  // Old motes were ~0.04–0.08; 1/8 → ~0.005–0.01
  const GEO_SIZE = 0.008;

  function Atmosphere(scene) {
    this.scene = scene;
    this._geo = new THREE.BoxGeometry(GEO_SIZE, GEO_SIZE, GEO_SIZE);
    this._motes = [];
    this._enabled = true;
    this._seedMotes();
  }

  Atmosphere.prototype._seedMotes = function () {
    for (let i = 0; i < MOTE_COUNT; i++) {
      const hex = Math.random() > 0.45 ? 0xc44a3a : 0x8a2820;
      const mat = new THREE.MeshBasicMaterial({
        color: hex,
        transparent: false,
        depthWrite: true,
      });
      const mesh = new THREE.Mesh(this._geo, mat);
      mesh.frustumCulled = false;
      const sc = 0.65 + Math.random() * 0.7; // ~0.005–0.01 world
      mesh.scale.setScalar(sc);
      this.scene.add(mesh);
      this._motes.push({
        mesh: mesh,
        ox: (Math.random() - 0.5) * 22,
        oy: 0.5 + Math.random() * 3.8,
        oz: (Math.random() - 0.5) * 22,
        phase: Math.random() * Math.PI * 2,
        drift: 0.12 + Math.random() * 0.28,
        bob: 0.15 + Math.random() * 0.35,
      });
    }
  };

  Atmosphere.prototype.update = function (dt, playerPos) {
    if (!this._enabled || !playerPos) return;
    const t = performance.now() * 0.001;
    for (let i = 0; i < this._motes.length; i++) {
      const m = this._motes[i];
      m.phase += dt * m.drift;
      const px = playerPos.x + m.ox + Math.sin(m.phase) * 0.9;
      const py = playerPos.y + m.oy + Math.sin(t * m.bob + m.phase) * 0.25;
      const pz = playerPos.z + m.oz + Math.cos(m.phase * 0.85) * 0.9;
      m.mesh.position.set(px, py, pz);
    }
  };

  global.VF = global.VF || {};
  global.VF.Atmosphere = null;
  global.VF.createAtmosphere = function (scene) {
    const atm = new Atmosphere(scene);
    global.VF.Atmosphere = atm;
    return atm;
  };
})(typeof window !== 'undefined' ? window : this);
