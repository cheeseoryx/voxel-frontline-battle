import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { defineConfig } from 'vite';
import { collectAssetDeclarationRoots } from './src/template-asset-roots';

const here = fileURLToPath(new URL('.', import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const emptyAssetRoot = resolve(monorepoRoot, 'templates', 'empty', 'assets');
const previewUiAuthoringMetaPath = resolve(
  here,
  'assets',
  'ui-authoring',
  'preview-hud.ui.html.meta.json',
);

// The UI authoring smoke validates the authoring gateway and capture lifecycle,
// not the full game-default asset closure. Keep that contract real while
// giving it the smallest deterministic Pack/shader graph: the empty template
// scene plus the catalogued UI source. The full Preview template smoke remains
// the owner for the default game's complete renderer/catalog closure.
const roots = [
  ...collectAssetDeclarationRoots(emptyAssetRoot),
  previewUiAuthoringMetaPath,
];

export default defineConfig({
  plugins: [
    // The app entry imports this virtual module even when the renderer falls
    // back. Keep the canonical shader plugin as its producer, but skip the
    // eager engine shader suite and authored material scan for this focused
    // authoring carrier.
    forgeaxShader({ engineEntries: false, publishAuthoredMaterialShaders: false }),
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('preview'),
      refresh: reloadAssetHost(),
      roots,
      importers: [createUiImporter()],
      ddc: {
        buildCacheRoot: resolve(monorepoRoot, 'shared-build-inputs', 'ddc'),
        projectDdcRoot: resolve(here, '.forgeax', 'ddc', 'ui-authoring'),
      },
    }),
  ],
  server: {
    fs: { allow: [monorepoRoot] },
  },
});
