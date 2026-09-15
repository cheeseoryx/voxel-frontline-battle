/** In-page screens shared by cover, lobby, and every match mode. */
(function (global) {
  'use strict';
  const ids = ['tdm', 'demo', 'ffa', 'gungame', 'core'];
  const names = {
    tdm: '团队死斗',
    demo: '爆破模式',
    ffa: '自由混战',
    gungame: '枪械模式',
    core: '核心攻防',
  };
  const params = new URLSearchParams(global.location.search);
  const selection = {
    mode: ids.includes(params.get('mode')) ? params.get('mode') : null,
    screen: null,
    room: /^[A-Z0-9]{4,8}$/.test(params.get('room') || '') ? params.get('room') : null,
  };

  let coverClick = null;

  function el(id) {
    return document.getElementById(id);
  }

  function hide(node) {
    if (node) node.classList.add('hidden');
  }

  function show(node) {
    if (node) node.classList.remove('hidden');
  }

  function showTransition(message) {
    if (!document.body) return;
    let panel = el('game-entry-transition');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'game-entry-transition';
      panel.setAttribute('role', 'status');
      panel.style.cssText =
        'position:fixed;inset:0;z-index:3000;display:grid;place-items:center;background:#15232ff2;color:#dcebf3;font:18px Microsoft YaHei, sans-serif;letter-spacing:2px';
      document.body.append(panel);
    }
    panel.textContent = message;
  }

  function hideTransition() {
    const panel = el('game-entry-transition');
    if (panel && typeof panel.remove === 'function') panel.remove();
  }

  function replaceQuery(mutate) {
    const url = new URL(global.location.href);
    mutate(url.searchParams);
    const next = url.pathname + url.search + url.hash;
    if (next !== global.location.pathname + global.location.search + global.location.hash) {
      global.history.replaceState(global.history.state, '', next);
    }
  }

  function setRuntime(runtime) {
    if (!document.body) return;
    document.body.dataset.gameRuntime = runtime;
    document.body.classList.toggle('frontline-small', runtime === 'small');
    document.body.classList.toggle('frontline-large', runtime !== 'small');
  }

  function goHome() {
    selection.screen = null;
    setRuntime('large');
    hide(el('mode-overlay'));
    hide(el('tutorial-overlay'));
    show(el('start-overlay'));
    hideTransition();
    replaceQuery((search) => {
      search.delete('screen');
      search.delete('mode');
      search.delete('room');
    });
  }

  function goLobby() {
    selection.screen = 'modes';
    setRuntime('large');
    hide(el('start-overlay'));
    hide(el('tutorial-overlay'));
    hideTransition();
    if (global.VF && typeof global.VF.openFrontlineHub === 'function') {
      global.VF.openFrontlineHub();
    } else if (global.VF && global.VF.UI && typeof global.VF.UI.openModeSelect === 'function') {
      global.VF.UI.openModeSelect();
    } else {
      show(el('mode-overlay'));
    }
    replaceQuery((search) => {
      search.delete('screen');
      search.delete('mode');
      search.delete('room');
    });
  }

  function bootSmallMode(mode, room) {
    if (!ids.includes(mode)) return;
    selection.mode = mode;
    selection.room = /^[A-Z0-9]{4,8}$/.test(room || '') ? room : null;
    setRuntime('small');
    hide(el('start-overlay'));
    if (global.VF && global.VF.GameModes && typeof global.VF.GameModes.setMode === 'function') {
      global.VF.GameModes.setMode(mode);
    }
    replaceQuery((search) => {
      search.delete('screen');
      search.set('mode', mode);
      if (selection.room) search.set('room', selection.room);
      else search.delete('room');
    });
    const session = global.VF && global.VF.ZaohuaOnline;
    const pvp = global.VF && global.VF.Pvp;
    const startLocal = function () {
      if (global.VF && typeof global.VF.startSmallMatch === 'function') {
        global.VF.startSmallMatch({ mode: 'pve' });
      }
    };
    if (session && session.ready && typeof session.ready.then === 'function') {
      session.ready
        .then(function (ok) {
          if (!ok || !pvp || typeof pvp.quickMatch !== 'function') return false;
          return pvp.quickMatch(mode, selection.room);
        })
        .then(function (matched) {
          if (!matched) startLocal();
        });
      return;
    }
    startLocal();
  }

  global.VFEntry = {
    selection,
    modeNames: names,
    showTransition,
    hideTransition,
    setRuntime,
    isSmall: function () {
      return document.body && document.body.dataset.gameRuntime === 'small';
    },
    openSmallBattle: function (mode, room) {
      bootSmallMode(ids.includes(mode) ? mode : 'tdm', room);
    },
    goHome,
    goLobby,
    get navigating() {
      return false;
    },
  };

  document.addEventListener(
    'click',
    function (event) {
      const cover = event.target.closest('#enter-hub-btn');
      if (cover && !cover.disabled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        coverClick = { x: event.clientX, y: event.clientY, at: performance.now() };
        goLobby();
        return;
      }
      // The lobby replaces the cover under the cursor, so a double click must not reach a mode card.
      if (
        coverClick &&
        performance.now() - coverClick.at < 500 &&
        event.detail > 0 &&
        Math.hypot(event.clientX - coverClick.x, event.clientY - coverClick.y) < 12 &&
        event.target.closest('[data-mode-action],[data-quick-mode]')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const button = event.target.closest('[data-game-entry]');
      if (!button || button.disabled) return;
      const target = button.getAttribute('data-game-entry');
      if (!['home', 'small-battle', 'lobby'].includes(target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (target === 'small-battle') global.VFEntry.openSmallBattle();
      else if (target === 'lobby') goLobby();
      else goHome();
    },
    true,
  );

  // A bookmarked or stale ?screen= no longer selects anything; drop it so reloads stay fail-closed.
  replaceQuery((search) => search.delete('screen'));

  if (document.body) setRuntime(document.body.dataset.gameRuntime || 'large');
  else document.addEventListener('DOMContentLoaded', function () {
    setRuntime(document.body.dataset.gameRuntime || 'large');
  });
})(window);
