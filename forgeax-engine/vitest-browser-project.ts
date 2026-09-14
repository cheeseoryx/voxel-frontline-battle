import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createParticleCodeNativeCooker } from '@forgeax/engine-vfx-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { targetProfileImporter } from './apps/game-capability-lab/assets/plugins/target-profile-importer';
import { websocketListenerCommands } from './packages/net-websocket/__tests__/support/ws-listener-commands';
import { createMaterialPackCooker } from './packages/shader-compiler/src/index';
import materialContractInventory from './scripts/material-contract-inventory.json' with {
  type: 'json',
};
import { materialProgramFixture } from './scripts/test/material-program-fixture';
import { weaponSpiritMaterialFixture } from './scripts/test/weapon-spirit-material-fixture';
import { playwrightWithBackgroundPages } from './vitest-browser-provider';

// Keep the browser project independently loadable. The full workspace config
// discovers every unit and dawn project; browser CI only needs this project,
// and loading the rest makes Vite's dependency optimizer exceed the heavy
// runner heap before a browser test can start.
const rootDir = fileURLToPath(new URL('.', import.meta.url));
const evidenceSourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();
const evidenceBuildId = `vitest-browser-${evidenceSourceSha.slice(0, 12)}`;
const materialPackages = [
  ...materialContractInventory.materialPackages.map((relativePath) =>
    resolve(rootDir, relativePath),
  ),
  resolve(rootDir, 'apps/game-capability-lab/assets/animated-target-material.pack.json'),
  resolve(rootDir, 'apps/game-capability-lab/assets/hit-flash-material.pack.json'),
];
const vfxModules = Object.fromEntries(
  ['hit.vfx.wgsl', 'charge.vfx.wgsl'].map((name) => [
    name,
    {
      entry: readFileSync(resolve(rootDir, 'apps/game-capability-lab/assets', name), 'utf8'),
    },
  ]),
);
const templatePackRoots = [
  'animated-target-material.pack.json',
  'base-material.pack.json',
  'charge-vfx-effect.pack.json',
  'hit-flash-material.pack.json',
  'hit-vfx-effect.pack.json',
  'hit-vfx-materials.pack.json',
  'multi-material-target.pack.json',
  'resonance-forge.pack.ts',
  'scene.pack.json',
  'target-profile.json.meta.json',
  'ui/hud.pack.json',
  'ui/settings.pack.json',
].map((relativePath) => resolve(rootDir, 'apps/game-capability-lab/assets', relativePath));
const surfaceEvidencePackRoots = [
  resolve(rootDir, 'templates/game-3d/assets/materials.pack.ts'),
  resolve(rootDir, 'apps/preview/assets/surface-standard-evidence.pack.ts'),
];
const surfaceOnly =
  process.env.FORGEAX_BROWSER_SURFACE_ONLY === '1' || process.env.FORGEAX_SURFACE_ONLY === '1';
const submoduleJpegMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/demo-assets/hello-sprite/wood-container.jpg.meta.json',
);
const submoduleBgmMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/collectathon-audio/bgm-loop.wav.meta.json',
);
const submoduleFbxDir = resolve(rootDir, 'forgeax-engine-assets/vendor/fbx-test');
const submoduleGlbDir = resolve(rootDir, 'forgeax-engine-assets/khronos-gltf-samples/BoxTextured');
const submoduleDejavuFontMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.ttf.meta.json',
);
const submoduleDejavuLegacyAtlasMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.atlas.png.meta.json',
);
const submoduleDejavuLegacyPackPath = resolve(
  rootDir,
  'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.font.pack.json',
);
const submoduleSpriteAtlasDir = resolve(
  rootDir,
  'forgeax-engine-assets/demo-assets/hello-sprite-atlas',
);
const browserVendorMetaRoots = [
  'learn-opengl/textures/awesomeface.png.meta.json',
  'learn-opengl/textures/bricks2.jpg.meta.json',
  'learn-opengl/textures/bricks2_disp.jpg.meta.json',
  'learn-opengl/textures/bricks2_normal.jpg.meta.json',
  'learn-opengl/textures/brickwall.jpg.meta.json',
  'learn-opengl/textures/brickwall_normal.jpg.meta.json',
  'learn-opengl/textures/container.jpg.meta.json',
  'learn-opengl/textures/container2.png.meta.json',
  'learn-opengl/textures/container2_specular.png.meta.json',
  'learn-opengl/textures/grass.png.meta.json',
  'learn-opengl/textures/marble.jpg.meta.json',
  'learn-opengl/textures/metal.png.meta.json',
  'learn-opengl/textures/newport_loft.hdr.meta.json',
  'learn-opengl/textures/hdr/newport_loft.hdr.meta.json',
  'learn-opengl/textures/toy_box_diffuse.png.meta.json',
  'learn-opengl/textures/toy_box_disp.png.meta.json',
  'learn-opengl/textures/toy_box_normal.png.meta.json',
  'learn-opengl/textures/window.png.meta.json',
  'learn-opengl/textures/wood.png.meta.json',
  'learn-opengl/meshes/cube-mesh.stub.meta.json',
  'learn-opengl/objects/backpack/backpack.gltf.meta.json',
  'learn-opengl/objects/planet/mars.png.meta.json',
  'learn-opengl/objects/planet/planet.gltf.meta.json',
  'learn-opengl/objects/rock/rock.gltf.meta.json',
  'learn-opengl/objects/rock/rock.png.meta.json',
].map((relativePath) => resolve(rootDir, 'forgeax-engine-assets', relativePath));
const entityVisibilityBrowserTest =
  'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts';
const producerReadiness =
  process.env.FORGEAX_BROWSER_PACK_READINESS === 'before-consume' ? 'before-consume' : 'on-demand';

export function createBrowserProject() {
  const runEntityVisibilityBrowserTest = process.env.FORGEAX_BROWSER_ENTITY_VISIBILITY === '1';
  const packRoots = surfaceOnly
    ? surfaceEvidencePackRoots
    : [
        resolve(rootDir, 'apps/learn-render/1.getting-started/4.textures/assets'),
        resolve(rootDir, 'apps/learn-render/1.getting-started/5.transformations/assets'),
        resolve(rootDir, 'apps/learn-render/1.getting-started/6.coordinate-systems/assets'),
        resolve(rootDir, 'apps/learn-render/1.getting-started/7.camera/assets'),
        resolve(rootDir, 'apps/learn-render/6.pbr/4.transmission-refraction/assets'),
        ...browserVendorMetaRoots,
        resolve(rootDir, 'forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf.meta.json'),
        ...templatePackRoots,
        ...surfaceEvidencePackRoots,
        resolve(
          rootDir,
          'forgeax-engine-assets/demo-assets/template-game-default/sky.hdr.meta.json',
        ),
        resolve(rootDir, 'forgeax-engine-assets/sfx'),
        submoduleJpegMetaPath,
        submoduleBgmMetaPath,
        submoduleFbxDir,
        submoduleGlbDir,
        submoduleDejavuFontMetaPath,
        submoduleDejavuLegacyAtlasMetaPath,
        submoduleDejavuLegacyPackPath,
        submoduleSpriteAtlasDir,
      ];
  const plugins = [
    materialProgramFixture(),
    materialProgramFixture(true),
    weaponSpiritMaterialFixture(),
    weaponSpiritMaterialFixture(true),
    forgeaxShader({ engineEntries: { pointShadows: true }, materialPackages }),
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('browser-tests'),
      producerReadiness: surfaceOnly ? 'before-consume' : producerReadiness,
      roots: packRoots,
      importers: [
        imageImporter,
        gltfImporter,
        audioImporter,
        fbxImporter,
        fontImporter,
        targetProfileImporter(),
      ],
      cookers: [
        createParticleCodeNativeCooker(vfxModules),
        createMaterialPackCooker([resolve(rootDir, 'templates/game-3d/assets/shaders')]),
      ],
    }),
  ];
  return {
    plugins,
    server: {
      fs: { allow: [rootDir] },
    },
    define: {
      'import.meta.env.FORGEAX_RUNTIME_SCOPE_ID': JSON.stringify('browser-tests'),
      'import.meta.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA': JSON.stringify(evidenceSourceSha),
      'import.meta.env.VITE_FORGEAX_EVIDENCE_BUILD_ID': JSON.stringify(evidenceBuildId),
      // CI may shorten only the high-density browser carriers; keep the flag
      // explicit in the browser bundle instead of relying on a Node-only
      // process shim.
      'import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT': JSON.stringify(
        process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT ?? '0',
      ),
    },
    test: {
      name: 'browser',
      include: ['**/*.browser.test.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/artifacts/**',
        '**/.worktrees/**',
        '**/.claude/worktrees/**',
        ...(runEntityVisibilityBrowserTest ? [] : [entityVisibilityBrowserTest]),
      ],
      // Chromium's lavapipe WebGPU device is shared by browser workers. Keep
      // one Vitest worker as the lifecycle boundary for this real-WebGPU
      // project; the split runner adds a process boundary between groups.
      fileParallelism: false,
      maxWorkers: 1,
      deps: {
        optimizer: {
          client: { enabled: false },
        },
      },
      browser: {
        enabled: true,
        commands: websocketListenerCommands,
        provider: playwrightWithBackgroundPages({
          launchOptions: {
            channel: 'chrome-beta',
            args: [
              '--enable-unsafe-webgpu',
              '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
              '--use-vulkan=swiftshader',
              '--disable-vulkan-surface',
              '--ignore-gpu-blocklist',
              '--disable-gpu-driver-bug-workarounds',
              '--disable-dawn-features=disallow_unsafe_apis',
              '--autoplay-policy=no-user-gesture-required',
            ],
          },
        }),
        instances: [{ browser: 'chromium' }],
        headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' && !!process.env.CI,
      },
    },
  };
}
