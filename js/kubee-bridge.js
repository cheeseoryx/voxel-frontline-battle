/**
 * kubee-bridge.js — when embedded under Kubee shell (iframe ?kubee=1),
 * bridge PVP messages via parent postMessage instead of PeerJS/Netlify.
 */
(function (global) {
  'use strict';

  const isKubeeEmbed =
    typeof location !== 'undefined' &&
    (/[?&]kubee=1(?:&|$)/.test(location.search) || global.parent !== global);

  if (!isKubeeEmbed || global.parent === global) {
    global.VF_KUBEE = { active: false };
    return;
  }

  const listeners = [];
  let lobby = null;
  let myId = null;

  function onMessage(ev) {
    const data = ev.data;
    if (!data || data.channel !== 'vf-kubee' || data.dir !== 'in') return;
    const msg = data.msg;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'kubee-welcome') {
      myId = msg.playerId;
    }
    if (msg.type === 'kubee-lobby') {
      lobby = msg;
      myId = msg.playerId || myId;
    }
    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](msg);
      } catch (err) {
        console.warn('[vf-kubee-bridge]', err);
      }
    }
  }

  global.addEventListener('message', onMessage);

  global.VF_KUBEE = {
    active: true,
    get lobby() {
      return lobby;
    },
    get playerId() {
      return myId;
    },
    onNet: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },
    send: function (payload) {
      try {
        global.parent.postMessage({ channel: 'vf-kubee', dir: 'out', msg: payload }, '*');
      } catch (_) {}
    },
    /** Ask parent to re-send lobby snapshot */
    pingParent: function () {
      try {
        global.parent.postMessage({ channel: 'vf-kubee', dir: 'out', msg: { type: 'kubee-child-ready' } }, '*');
      } catch (_) {}
    },
  };

  // Notify parent that game bridge is ready
  setTimeout(function () {
    global.VF_KUBEE.pingParent();
  }, 100);
})(window);
