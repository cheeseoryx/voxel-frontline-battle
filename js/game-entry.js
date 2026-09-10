/** Shared navigation for the two game runtimes in this static project. */
(function (global) {
  'use strict';
  const root = new URL('../', document.currentScript.src);
  function navigate(relative) {
    const destination = new URL(relative, root);
    if (global.parent !== global && /[?&]kubee=1(?:&|$)/.test(global.location.search)) {
      destination.searchParams.set('kubee', '1');
    }
    global.location.assign(destination.href);
  }
  global.VFEntry = {
    openSmallBattle: function () { navigate('modes/small-battle/index.html'); },
    goHome: function () { navigate('index.html'); },
  };
  document.addEventListener('click', function (event) {
    const button = event.target.closest('[data-game-entry]');
    if (!button || button.disabled) return;
    const target = button.getAttribute('data-game-entry');
    if (target !== 'small-battle' && target !== 'home') return;
    event.preventDefault();
    event.stopPropagation();
    if (target === 'small-battle') global.VFEntry.openSmallBattle();
    else global.VFEntry.goHome();
  });
})(window);
