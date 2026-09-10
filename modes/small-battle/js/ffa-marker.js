/**
 * ffa-marker.js — 自由混战 领先者标记 (leader crown).
 *
 * Per the design's 7.3「领先者标记」, the current #1 wears a gold crown that is
 * visible to everyone (枪打出头鸟). Only an AI leader is crowned in the world —
 * a first-person player cannot see their own head, so the player-leader case is
 * handled by a「众矢之的」toast in FfaMatch instead.
 *
 * The crown renders through walls (depthTest off, high renderOrder) so the
 * leader stays trackable across the arena. FfaMatch.update drives sync(); the
 * mesh is built lazily and torn down on stop().
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});
  const T = global.THREE;

  const HEAD_Y = 2.3;
  const GOLD = 0xffd54a;
  const GOLD_DEEP = 0xd9a021;

  let crown = null;
  let spin = 0;

  function mat(color) {
    return new T.MeshBasicMaterial({
      color: color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.96,
    });
  }

  function build() {
    if (!T) return null;
    const g = new T.Group();
    const band = new T.Mesh(new T.CylinderGeometry(0.32, 0.32, 0.16, 6), mat(GOLD_DEEP));
    g.add(band);
    const spikes = 6;
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * Math.PI * 2;
      const spike = new T.Mesh(new T.ConeGeometry(0.08, 0.26, 4), mat(GOLD));
      spike.position.set(Math.cos(a) * 0.3, 0.18, Math.sin(a) * 0.3);
      g.add(spike);
    }
    g.renderOrder = 998;
    g.traverse(function (o) {
      if (o.isMesh) o.renderOrder = 998;
    });
    return g;
  }

  const Marker = {
    /**
     * Crown the current AI leader; hide otherwise. Called each battle frame.
     * Shared by 自由混战 (leader = most kills) and 枪械模式 (leader = highest
     * weapon level), so the "has actually scored yet" test accepts either.
     */
    sync: function (dt) {
      const g = VF.game;
      const gg = VF.GgMatch && VF.GgMatch.isRunning() ? VF.GgMatch : null;
      const match = gg || VF.FfaMatch;
      if (!T || !g || !g.scene || !match || !match.leaderMarkerOn()) {
        this.hide();
        return;
      }
      const lead = match.ranking()[0];
      // No lead until someone actually scores; the player's own crown is skipped
      // (invisible in first person — the「众矢之的」toast covers it).
      const scored = lead ? (lead.kills || 0) + (lead.level || 0) : 0;
      if (!lead || scored <= 0 || lead.id === 'player') {
        this.hide();
        return;
      }
      const unit = this._findUnit(lead.id);
      if (!unit || !unit.alive || !unit.mesh) {
        this.hide();
        return;
      }

      if (!crown) crown = build();
      if (!crown) return;
      if (!crown.parent) g.scene.add(crown);
      crown.visible = true;

      spin += (dt || 0.016) * 1.6;
      const p = unit.mesh.position;
      crown.position.set(p.x, p.y + HEAD_Y + Math.sin(spin) * 0.05, p.z);
      crown.rotation.y = spin;
    },

    hide: function () {
      if (crown) crown.visible = false;
    },

    stop: function () {
      if (crown && crown.parent) crown.parent.remove(crown);
      crown = null;
    },

    _findUnit: function (id) {
      const ai = VF.game && VF.game.ai;
      if (!ai) return null;
      const lists = [ai.blue, ai.red];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === id) return list[i];
        }
      }
      return null;
    },
  };

  VF.FfaMarker = Marker;
})(typeof window !== 'undefined' ? window : globalThis);