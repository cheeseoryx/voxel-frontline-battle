import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  // Keep the dev carrier inspectable through the same single-frame RHI tape
  // route used by the engine debugging workflow. Production builds define the
  // flag to "0" and tree-shake the recorder branch.
  plugins: [forgeaxShader() as never, vitePluginRhiDebug()],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: resolve(here, 'index.html') } },
});
