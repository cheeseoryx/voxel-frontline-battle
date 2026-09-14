import { Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import type { Plugin } from '@forgeax/engine/plugin';
import { mountUi, type UiAsset, type UiInstance } from '@forgeax/engine/ui';
import { authoredGuid } from '../shared/guid.ts';

type SceneHost = NonNullable<import('@forgeax/engine/app').GameHost>;

const uiPlugin: Plugin = {
  name: 'game-3d/ui',
  inject: ['world', 'gameHost'],
  async apply(ctx) {
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('game-3d/ui requires the App-owned GameHost');
    const ui = await mountGuideUi(host);
    ctx.world.addSystem(Update, {
      name: 'game-3d-ui',
      queries: [],
      fn: () => updateGuideUi(ui, ctx.world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY).mouse.pointerLocked),
    }).unwrap();
    ctx.effect(function* () {
      yield () => ctx.world.removeSystem(Update, 'game-3d-ui').unwrap();
      yield () => ui?.dispose();
    }, 'game-3d/ui');
  },
};

export default uiPlugin;

async function mountGuideUi(host: SceneHost): Promise<UiInstance | undefined> {
  const guideUi = authoredGuid('ui/guide');
  if (!guideUi.ok) throw guideUi.error;
  const loaded = await host.assets.loadByGuid<UiAsset>(guideUi.value);
  if (!loaded.ok) throw loaded.error;
  const mounted = mountUi(loaded.value, { root: host.uiRoot ?? document.body, layer: 50 });
  if (!mounted.ok) throw mounted.error;
  return mounted.value;
}

function updateGuideUi(ui: UiInstance | undefined, pointerLocked: boolean): void {
  if (ui === undefined) return;
  ui.host.classList.toggle('locked', pointerLocked);
  const label = ui.host.shadowRoot?.querySelector<HTMLElement>('[data-ui-slot="lock"]');
  if (label !== null && label !== undefined) {
    label.textContent = pointerLocked ? 'Camera locked · mouse look active' : 'Click the game to lock the camera';
  }
}
