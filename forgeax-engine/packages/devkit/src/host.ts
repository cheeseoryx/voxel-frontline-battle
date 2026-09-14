import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { type BackendHost, createBackendHost } from '@forgeax/engine-host/backend';
import { createHostAssembly } from '@forgeax/engine-host/protocol';
import { attachHostWebSocketServer, createHostTransport } from '@forgeax/engine-host/transport';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { iesImporter } from '@forgeax/engine-import';
import { BUILTIN_MESH_ASSETS } from '@forgeax/engine-pack/builtin';
import { scanInventory } from '@forgeax/engine-pack/scanner';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import type { Plugin as CordisPlugin } from '@forgeax/engine-plugin';
import { type GamePluginEntry, projectPluginEntries } from '@forgeax/engine-plugin/loader';
import { validateCanonicalKitReceipt } from '@forgeax/engine-preview';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import {
  createServer as createViteServer,
  type InlineConfig,
  type Plugin,
  build as viteBuild,
  preview as vitePreview,
} from 'vite';
import { type WebSocket, WebSocketServer } from 'ws';
import { verifyDist, writeDistManifest } from './dist.js';
import { inspectEngineWorkspace, readEngineBinding } from './engine-binding.js';
import type { BootstrapRoot } from './host/base-host.js';
import { deriveRealmCatalogs } from './project/catalog.js';
import { commandError, readProjectFacts } from './project.js';
import type {
  BuildOptions,
  CommandResult,
  ProjectCommandOptions,
  ProjectFacts,
  ProjectPortOptions,
} from './types.js';
import { resolveProjectPort } from './types.js';

const activeDevKitHosts = new Set<BackendHost>();

export async function disposeDevKitHosts(): Promise<void> {
  const hosts = [...activeDevKitHosts];
  activeDevKitHosts.clear();
  for (const host of hosts) await host.dispose();
}

interface CatalogModule {
  readonly name: string;
  readonly realm: 'host' | 'engine';
}

export const DEFAULT_IMPORTERS: readonly Importer[] = [
  audioImporter,
  imageImporter,
  fbxImporter,
  gltfImporter,
  fontImporter,
  iesImporter,
  createUiImporter(),
];

export function ignoreDevKitCatalogPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').includes('shaders');
}

export function devKitDdcRoots(projectRoot: string): {
  readonly buildCacheRoot: string;
  readonly projectDdcRoot: string;
} {
  return {
    buildCacheRoot: resolve(projectRoot, '.forgeax', 'ddc', 'build-cache'),
    projectDdcRoot: resolve(projectRoot, '.forgeax', 'ddc', 'v2'),
  };
}

function isResourcePreviewIgnoredPath(path: string): boolean {
  return (
    ignoreDevKitCatalogPath(path) ||
    path.endsWith('.wgsl.meta.json') ||
    path.endsWith('target-profile.json.meta.json')
  );
}

function isProjectSourceIgnoredPath(path: string): boolean {
  return (
    ignoreDevKitCatalogPath(path) ||
    path.endsWith('.wgsl.meta.json') ||
    path.endsWith('target-profile.json.meta.json')
  );
}

interface CanonicalKitLocation {
  readonly root: string;
  readonly guid: string;
}

/**
 * Materialize the Engine-owned procedural mesh descriptors missing from a
 * standalone project. The project remains the author of any descriptor it
 * explicitly carries (for example, the game-default template); generated
 * rows fill only the GUID closure required by legacy scenes that reference
 * Engine builtins without embedding a duplicate declaration.
 */
async function prepareBuiltinPack(
  projectRoots: readonly string[],
  generated: string,
  ignorePath: (path: string) => boolean,
): Promise<string | undefined> {
  const inventory = await scanInventory(projectRoots, { ignorePath });
  if (!inventory.ok) return undefined;
  const declared = new Set<string>();
  for (const declaration of inventory.value.declarations.values()) {
    if (declaration.format === 'pack.json') {
      if (declaration.value.schemaVersion === '3.0.0') {
        const parsed = parsePackSourceJson(declaration.value);
        if (parsed.ok && parsed.value.format === 'direct') {
          const projected = projectDirectPackJson(parsed.value);
          if (projected.ok) {
            for (const asset of projected.value.assets) declared.add(asset.guid.toLowerCase());
          }
        }
      } else {
        for (const asset of declaration.value.assets) declared.add(asset.guid.toLowerCase());
      }
      continue;
    }
    if (declaration.format === 'pack.ts') continue;
    const subAssets =
      'subAssets' in declaration.value && Array.isArray(declaration.value.subAssets)
        ? declaration.value.subAssets
        : [];
    for (const asset of subAssets) declared.add(asset.guid.toLowerCase());
  }
  const missing = BUILTIN_MESH_ASSETS.filter((asset) => !declared.has(asset.guid.toLowerCase()));
  if (missing.length === 0) return undefined;
  const packPath = resolve(generated, 'engine-builtins.pack.json');
  await writeFile(
    packPath,
    `${JSON.stringify(
      {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: missing.map((asset) => ({
          guid: asset.guid,
          kind: 'mesh',
          payload: { geometry: asset.geometry },
          refs: [],
          artifacts: {},
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return packPath;
}

/** Return authored single-material packs to the shader compiler's static graph. */
async function discoverMaterialPackages(
  projectRoots: readonly string[],
  ignorePath: (path: string) => boolean,
): Promise<readonly string[]> {
  const inventory = await scanInventory(projectRoots, { ignorePath });
  if (!inventory.ok) return [];
  const paths: string[] = [];
  for (const declaration of inventory.value.declarations.values()) {
    if (declaration.format !== 'pack.json') continue;
    let assets: readonly {
      readonly kind?: unknown;
      readonly payload?: { readonly kind?: unknown };
    }[] = [];
    if (declaration.value.schemaVersion === '3.0.0') {
      const parsed = parsePackSourceJson(declaration.value);
      if (!parsed.ok || parsed.value.format !== 'direct') continue;
      const projected = projectDirectPackJson(parsed.value);
      if (!projected.ok) continue;
      assets = projected.value.assets;
    } else {
      assets = declaration.value.assets;
    }
    if (
      assets.length === 1 &&
      assets[0]?.kind === 'material' &&
      assets[0].payload?.kind === 'material'
    )
      paths.push(declaration.sourcePath);
  }
  return paths.sort();
}

const hostRequire = createRequire(import.meta.url);

interface EngineWorkspacePackage {
  readonly root: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

type PackageExportValue = string | null | { readonly [key: string]: PackageExportValue };

function findEngineWorkspaceRoot(): string | undefined {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(resolve(cursor, 'pnpm-workspace.yaml'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

async function engineWorkspacePackages(
  workspaceRoot = findEngineWorkspaceRoot(),
): Promise<ReadonlyMap<string, EngineWorkspacePackage>> {
  if (workspaceRoot === undefined) return new Map<string, EngineWorkspacePackage>();
  const packageRoot = resolve(workspaceRoot, 'packages');
  // A generated game is a pnpm workspace too, but it does not own a local
  // `packages/` tree. Its installed Engine packages are resolved by Node;
  // the workspace resolver is only an SDK/source-checkout fallback.
  if (!existsSync(packageRoot)) return new Map<string, EngineWorkspacePackage>();
  const packages = new Map<string, EngineWorkspacePackage>();
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = resolve(packageRoot, entry.name);
    try {
      const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as unknown;
      if (manifest === null || typeof manifest !== 'object') continue;
      const name = (manifest as { readonly name?: unknown }).name;
      if (typeof name === 'string' && name.startsWith('@forgeax/engine')) {
        packages.set(name, { root, manifest: manifest as Readonly<Record<string, unknown>> });
      }
    } catch {
      // A partial SDK/source checkout may omit an unrelated package manifest. The
      // package remains resolvable from the consumer project when available.
    }
  }
  return packages;
}

function conditionalExport(value: PackageExportValue): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || Array.isArray(value)) return undefined;
  for (const condition of ['browser', 'import', 'node', 'default']) {
    const candidate = value[condition];
    if (candidate === undefined) continue;
    const selected = conditionalExport(candidate);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function packageExportTarget(
  manifest: Readonly<Record<string, unknown>>,
  subpath: string,
): string | undefined {
  const exportsValue = manifest.exports as PackageExportValue | undefined;
  if (exportsValue === undefined) {
    if (subpath.length > 0) return undefined;
    const main = manifest.module ?? manifest.main;
    return typeof main === 'string' ? main : undefined;
  }
  if (typeof exportsValue === 'string' || exportsValue === null) {
    return subpath.length === 0 ? conditionalExport(exportsValue) : undefined;
  }
  const keys = Object.keys(exportsValue);
  const subpathMap = keys.some((key) => key === '.' || key.startsWith('./'));
  if (!subpathMap) return subpath.length === 0 ? conditionalExport(exportsValue) : undefined;
  const requested = subpath.length === 0 ? '.' : `./${subpath}`;
  const exact = exportsValue[requested];
  if (exact !== undefined) return conditionalExport(exact);
  for (const key of keys) {
    const marker = key.indexOf('*');
    if (marker < 0) continue;
    const prefix = key.slice(0, marker);
    const suffix = key.slice(marker + 1);
    if (!requested.startsWith(prefix) || !requested.endsWith(suffix)) continue;
    const replacement = requested.slice(prefix.length, requested.length - suffix.length);
    const exportTarget = exportsValue[key];
    if (exportTarget === undefined) continue;
    const selected = conditionalExport(exportTarget);
    return selected?.replaceAll('*', replacement);
  }
  return undefined;
}

function engineWorkspaceImport(
  source: string,
  packages: ReadonlyMap<string, EngineWorkspacePackage>,
): string | undefined {
  if (!source.startsWith('@forgeax/engine')) return undefined;
  const separator = source.indexOf('/', '@forgeax/engine'.length);
  const packageName = separator < 0 ? source : source.slice(0, separator);
  const subpath = separator < 0 ? '' : source.slice(separator + 1);
  const packageInfo = packages.get(packageName);
  if (packageInfo === undefined) return undefined;
  const target = packageExportTarget(packageInfo.manifest, subpath);
  if (target === undefined) return undefined;
  const absolute = resolve(packageInfo.root, target);
  const inside = relative(packageInfo.root, absolute);
  if (inside === '..' || inside.startsWith(`..${sep}`) || absolute === packageInfo.root) {
    return undefined;
  }
  return absolute;
}

async function createEngineWorkspaceResolver(projectRoot: string): Promise<Plugin | undefined> {
  const binding = await readEngineBinding(projectRoot);
  if (!binding.ok) {
    throw new Error(`${binding.error.code}: ${binding.error.hint}`);
  }
  const localRoot = binding.value?.path;
  if (localRoot !== undefined) {
    const inspected = await inspectEngineWorkspace(localRoot);
    if (!inspected.ok) throw new Error(`${inspected.error.code}: ${inspected.error.hint}`);
  }
  const packages = await engineWorkspacePackages(localRoot);
  if (packages.size === 0) return undefined;
  return {
    name: 'forgeax:devkit-engine-workspace-resolver',
    enforce: 'pre',
    async resolveId(source, importer) {
      const bareSource = source.split('?', 1)[0] ?? source;
      if (!bareSource.startsWith('@forgeax/engine')) return null;
      if (localRoot !== undefined) return engineWorkspaceImport(bareSource, packages);
      try {
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (resolved !== null) return resolved;
      } catch {
        // Fall through to the Engine workspace only when the external project
        // has no installed copy of this package.
      }
      return engineWorkspaceImport(bareSource, packages);
    },
  };
}

/**
 * Reuse the production host's workspace fallback when a second bundle pass
 * resolves Engine packages from a source checkout.
 */
export async function createEngineWorkspaceResolverForProject(
  projectRoot: string,
): Promise<Plugin | undefined> {
  return createEngineWorkspaceResolver(projectRoot);
}

async function consumerEngineAliases(
  projectRoot: string,
): Promise<readonly { readonly find: string; readonly replacement: string }[]> {
  const root = resolve(projectRoot, 'node_modules', '.pnpm', 'node_modules', '@forgeax');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('engine-'))
      .map((entry) => ({
        find: `@forgeax/${entry.name}`,
        replacement: resolve(root, entry.name),
      }))
      .sort((a, b) => a.find.localeCompare(b.find));
  } catch {
    return [];
  }
}

async function resolveCanonicalKit(): Promise<CanonicalKitLocation> {
  const packageJson = hostRequire.resolve('@forgeax/engine-preview/package.json');
  const root = resolve(packageJson, '..', 'assets/canonical-kit');
  if (!existsSync(root)) throw new Error(`canonical preview kit root is missing: ${root}`);
  const receiptPath = resolve(root, 'cook-receipt.json');
  const receipt = validateCanonicalKitReceipt(JSON.parse(await readFile(receiptPath, 'utf8')));
  if (!receipt.ok) {
    throw new Error(`${receipt.error.code}: ${receipt.error.detail.field}`);
  }
  const sourcePath = resolve(root, receipt.value.transport.source);
  const metaPath = resolve(root, receipt.value.transport.meta);
  if (!existsSync(sourcePath) || !existsSync(metaPath)) {
    throw new Error('canonical preview kit source and Meta must be package-owned files');
  }
  return { root, guid: receipt.value.source.guid };
}

function moduleSpecifier(from: string, to: string): string {
  const value = relative(from, to).split(sep).join('/');
  return value.startsWith('.') ? value : `./${value}`;
}

function catalogModules(facts: ProjectFacts): CatalogModule[] {
  const catalogs = deriveRealmCatalogs(facts.plugins);
  return [
    ...catalogs.host.map(({ name }) => ({ name, realm: 'host' as const })),
    ...catalogs.engine.map(({ name }) => ({ name, realm: 'engine' as const })),
  ];
}

/**
 * Keep DevKit development on the same backend-derived assembly path as live
 * applications. The generated player still uses a frozen assembly for build
 * and preview, while this control socket supplies the source-session assembly.
 */
function devKitHostBridge(facts: ProjectFacts, bootstrapRoot: BootstrapRoot): Plugin {
  const realm = process.env.FORGEAX_DEV_EXECUTION === 'engine-worker' ? 'host' : 'engine';
  const projectEntries = projectPluginEntries(facts.plugins as readonly GamePluginEntry[], realm);
  const engineModules = catalogModules(facts)
    .filter((module) => module.realm === realm)
    .map((module) => ({ ...module, version: 'static' as const }));
  const entries =
    bootstrapRoot === 'resource-bootstrap'
      ? projectEntries.filter((entry) => !entry.name.startsWith('.') && entry.inject === undefined)
      : projectEntries;
  const bootstrapEntries = entries.filter((entry) => entry.inject === undefined);
  return {
    name: 'forgeax:devkit-backend-host',
    async configureServer(server) {
      const httpServer = server.httpServer;
      if (httpServer === undefined || httpServer === null) return;
      const lifecycleServer: EventEmitter = httpServer;
      const transport = createHostTransport();
      const sockets = new Set<() => void>();
      const socketServer = new WebSocketServer({ noServer: true });
      let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
      const onConnection = (socket: WebSocket): void => {
        const dispose = attachHostWebSocketServer(socket, transport);
        sockets.add(dispose);
        socket.once('close', () => sockets.delete(dispose));
      };
      socketServer.on('connection', onConnection);
      const onUpgrade = (
        request: import('node:http').IncomingMessage,
        socket: import('node:net').Socket,
        head: Buffer,
      ) => {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== '/__forgeax/host') return;
        socketServer.handleUpgrade(request, socket, head, (client) => {
          socketServer.emit('connection', client, request);
        });
      };
      const hostLifecyclePlugin: CordisPlugin = {
        name: 'forgeax:devkit-host-websocket-lifecycle',
        apply(ctx) {
          ctx.effect(() => {
            const onClose = (): void => {
              void backend?.dispose();
            };
            lifecycleServer.on('upgrade', onUpgrade);
            lifecycleServer.once('close', onClose);
            return () => {
              lifecycleServer.off('upgrade', onUpgrade);
              lifecycleServer.off('close', onClose);
              for (const dispose of sockets) dispose();
              sockets.clear();
              try {
                socketServer.close();
              } catch {
                // Vite may close the HTTP server before the host Fiber.
              }
              transport.close('devkit host lifecycle disposed');
              void backend?.dispose();
            };
          }, 'devkit/host-websocket');
        },
      };
      try {
        let promoted = bootstrapEntries.length === entries.length;
        backend = await createBackendHost({
          realm,
          entries: bootstrapEntries,
          modules: engineModules,
          transport,
          startupPlugins: [hostLifecyclePlugin],
          onActivationReport: async (report) => {
            if (!promoted && report.state === 'active') {
              promoted = true;
              await backend?.update({ entries, backendEntries: [] });
            }
          },
        });
      } catch (error) {
        try {
          socketServer.close();
        } catch {
          // No listener was installed when backend startup failed.
        }
        transport.close();
        throw error;
      }
    },
  };
}

function catalogImport(facts: ProjectFacts, generated: string, name: string): string {
  const specifier = name.startsWith('.')
    ? moduleSpecifier(generated, resolve(facts.root, name))
    : name;
  return `() => import(${JSON.stringify(specifier)})`;
}

/**
 * The Engine Worker cannot inherit the page Host's Loader tree.  Emit one
 * realm-local bootstrap that constructs the same project plugin closure inside
 * the selected World.  This keeps the Project manifest and static Vite
 * catalog as the only module authorities for both execution tiers.
 */
function executionBootstrapSource(facts: ProjectFacts, generated: string): string {
  const engineModules = catalogModules(facts).filter((module) => module.realm === 'engine');
  const catalog = engineModules
    .map((module) => {
      const specifier = module.name.startsWith('.')
        ? moduleSpecifier(generated, resolve(facts.root, module.name))
        : module.name;
      return `  [${JSON.stringify(module.name)}, { realm: 'engine', version: 'static', load: () => import(${JSON.stringify(specifier)}) }],`;
    })
    .join('\n');
  const projectEntries = projectPluginEntries(
    facts.plugins as readonly GamePluginEntry[],
    'engine',
  );
  return `import { audioPlugin } from '@forgeax/engine/audio';
import { skinningPlugin } from '@forgeax/engine/skinning';
import type { Plugin } from '@forgeax/engine/plugin';
import type { SceneAsset } from '@forgeax/engine/types';
import { bootstrapCatalogLoader, type PluginCatalog } from '@forgeax/engine/plugin/loader';

const defaultSceneGuid = ${JSON.stringify(facts.defaultScene ?? null)};
const projectPluginCatalog = new Map([
${catalog}
]) satisfies PluginCatalog;
const projectEntries = ${JSON.stringify(projectEntries)};

const workerGameHostPlugin: Plugin = {
  name: 'forgeax:worker-game-host',
  inject: ['world', 'renderer', 'assets', 'executionBootstrapHost'],
  async apply(ctx) {
    const assets = ctx.assets;
    if (assets === undefined) throw new Error('forgeax: Worker GameHost requires AssetRegistry');
    let defaultScene;
    let defaultSceneRoot;
    if (defaultSceneGuid !== null) {
      const loaded = await assets.loadByGuid<SceneAsset>(assets.parseGuid(defaultSceneGuid));
      if (!loaded.ok) throw loaded.error;
      defaultScene = loaded.value;
      const handle = ctx.world.allocSharedRef('SceneAsset', loaded.value);
      const instantiated = assets.instantiate<SceneAsset>(handle, ctx.world);
      if (!instantiated.ok) throw instantiated.error;
      defaultSceneRoot = instantiated.value;
    }
    const renderer = (ctx as unknown as { readonly renderer?: unknown }).renderer;
    const host = {
      canvas: ctx.executionBootstrapHost.canvas,
      ...(renderer === undefined ? {} : { renderer }),
      assets,
      app: { world: ctx.world, ...(renderer === undefined ? {} : { renderer }), assets },
      ...(defaultScene === undefined ? {} : { defaultScene }),
      ...(defaultSceneRoot === undefined ? {} : { defaultSceneRoot }),
      setPointerLockAllowed: (allowed) => ctx.executionBootstrapHost.setPointerLockAllowed(allowed),
    };
    ctx.provide('gameHost', host);
  },
};

const projectPluginLoader: Plugin = {
  name: 'forgeax:worker-project-plugins',
  async apply(ctx) {
    const loaded = await bootstrapCatalogLoader(ctx.root, projectPluginCatalog, 'engine', {
      catalogDigest: 'static',
      supportedRealms: ['engine'],
    });
    if (!loaded.ok) throw loaded.error;
    await loaded.value.loader.root.update(projectEntries);
    await loaded.value.loader.await();
  },
};

export default function executionBootstrap() {
  return {
    plugins: [audioPlugin(), skinningPlugin(), workerGameHostPlugin, projectPluginLoader],
  };
}
`;
}

function hostSource(
  facts: ProjectFacts,
  bootstrapRoot: BootstrapRoot,
  canonicalEnvironmentGuid?: string,
): string {
  const generated = resolve(facts.root, '.forgeax', 'generated');
  const plugins =
    bootstrapRoot === 'resource-bootstrap'
      ? []
      : [`webAudioPlugin()`, `audioPlugin()`, `skinningPlugin()`];
  const engineEntries = projectPluginEntries(facts.plugins as readonly GamePluginEntry[], 'engine');
  const engineModules = catalogModules(facts).map((module) => ({ ...module, version: 'static' }));
  const hostEntries = projectPluginEntries(facts.plugins as readonly GamePluginEntry[], 'host');
  const initialAssembly = createHostAssembly({
    entries: engineEntries.filter(
      (entry) => !entry.name.startsWith('.') && entry.inject === undefined,
    ),
    modules: engineModules,
  });
  const frozenAssembly = createHostAssembly({ entries: engineEntries, modules: engineModules });
  const hostAssembly = createHostAssembly({ entries: hostEntries, modules: engineModules });
  return `import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp, createToolPreviewHost, createToolPreviewRecipe, fitToolPreviewCameraToAabb, gameHostPlugin, replayToolPreviewCapture, type App } from '@forgeax/engine/app';
import { Context } from '@forgeax/engine/plugin';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { createCatalogSource } from '@forgeax/engine/assets-runtime';
import {
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from 'virtual:forgeax/pack-runtime';
import { inspectCatalogPlugins } from '@forgeax/engine/plugin';
import { createFrontendHost } from '@forgeax/engine/host/frontend';
import { connectHostWebSocket, HOST_ASSEMBLY_SERVICE } from '@forgeax/engine/host/transport';
import { audioPlugin } from '@forgeax/engine/audio';
import { webAudioPlugin } from '@forgeax/engine/audio-webaudio';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { mat4 } from '@forgeax/engine/math';
import { CAMERA_PROJECTION_ORTHOGRAPHIC, Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, Skylight, SkyboxBackground, TONEMAP_NONE, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { type SceneAsset } from '@forgeax/engine/types';
import { ParticleEffectPlayer, vfxGpuEffectContribution } from '@forgeax/engine/vfx';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';

const pluginCatalog = new Map([
${catalogModules(facts)
  .map(
    ({ name, realm }) =>
      `  [${JSON.stringify(name)}, { realm: ${JSON.stringify(realm)}, version: 'static', load: ${catalogImport(facts, generated, name)} }],`,
  )
  .join('\n')}
]);
const pluginEntries = ${JSON.stringify(facts.plugins, null, 2)};
const initialAssembly = ${JSON.stringify(initialAssembly)};
const frozenAssembly = ${JSON.stringify(
    bootstrapRoot === 'resource-bootstrap' ? initialAssembly : frozenAssembly,
  )};
const hostAssembly = ${JSON.stringify(hostAssembly)};
const bootstrapRoot = ${JSON.stringify(bootstrapRoot)};
const canonicalEnvironmentGuid = ${JSON.stringify(canonicalEnvironmentGuid ?? null)};
const resourceValue = new URLSearchParams(location.search).get('forgeax-resource-preview');
const resource = resourceValue === null ? undefined : JSON.parse(resourceValue);
const executionTier = import.meta.env.VITE_FORGEAX_EXECUTION_TIER === 'engine-worker'
  ? 'engine-worker'
  : undefined;
const workerExecution = executionTier === 'engine-worker';
const selectedInitialAssembly = workerExecution ? hostAssembly : initialAssembly;
const selectedFrozenAssembly = workerExecution ? hostAssembly : frozenAssembly;
const previewCameraEntities = new WeakMap();
const previewCameraTargets = new WeakMap();
let previewWorld;
const vfxRuntimeHost = resource?.kind === 'vfx'
  ? createVfxRuntimeHost({
      camera: {
        read(world) {
          const cameraEntity = previewCameraEntities.get(world);
          if (cameraEntity === undefined) return undefined;
          const transform = world.get(cameraEntity, Transform);
          const camera = world.get(cameraEntity, Camera);
          if (!transform.ok || !camera.ok) return undefined;
          const position = new Float32Array(transform.value.pos);
          const target = previewCameraTargets.get(world) ?? [0, 0, 0];
          return {
            position,
            right: new Float32Array([1, 0, 0]),
            up: new Float32Array([0, 1, 0]),
            viewProjection: mat4.computeViewProj(
              mat4.create(),
              position,
              target,
              [0, 1, 0],
              camera.value.fov,
              camera.value.aspect,
              camera.value.near,
              camera.value.far,
            ),
          };
        },
      },
    })
  : undefined;

function previewVfxBounds(payload) {
  if (payload?.kind !== 'particle-effect' || payload.program?.emitters?.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const emitter of payload.program.emitters) {
    const bounds = emitter.bounds;
    if (bounds?.kind === 'sphere' && Array.isArray(bounds.center) && typeof bounds.radius === 'number') {
      const [x, y, z] = bounds.center;
      if (![x, y, z, bounds.radius].every((value) => typeof value === 'number' && Number.isFinite(value)) || bounds.radius < 0) return undefined;
      minX = Math.min(minX, x - bounds.radius);
      minY = Math.min(minY, y - bounds.radius);
      minZ = Math.min(minZ, z - bounds.radius);
      maxX = Math.max(maxX, x + bounds.radius);
      maxY = Math.max(maxY, y + bounds.radius);
      maxZ = Math.max(maxZ, z + bounds.radius);
      continue;
    }
    if (bounds?.kind === 'aabb' && Array.isArray(bounds.min) && Array.isArray(bounds.max)) {
      const [loX, loY, loZ] = bounds.min;
      const [hiX, hiY, hiZ] = bounds.max;
      if (![loX, loY, loZ, hiX, hiY, hiZ].every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
      minX = Math.min(minX, loX);
      minY = Math.min(minY, loY);
      minZ = Math.min(minZ, loZ);
      maxX = Math.max(maxX, hiX);
      maxY = Math.max(maxY, hiY);
      maxZ = Math.max(maxZ, hiZ);
      continue;
    }
    return undefined;
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return undefined;
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
  return { aabb: [minX, minY, minZ, maxX, maxY, maxZ], center, radius };
}

const canvas = document.querySelector('#app');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('forgeax: missing canvas');
const resizeCanvas = () => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
};
const resizeObserver = new ResizeObserver(resizeCanvas);
resizeObserver.observe(canvas);
resizeCanvas();
const runtimeScopeBinding = runtimeBinding;
if (runtimeScopeBinding === undefined) {
  throw new Error('forgeax: Vite Pack runtime binding is required in the generated host');
}
const assetCatalog = createCatalogSource({
  url: import.meta.env.DEV
    ? runtimeScopeBinding.catalogUrl
    : new URL('pack-index.json', document.baseURI).href,
  ...(import.meta.env.DEV ? { expectedScope: runtimeScopeBinding } : {}),
});
const bundler = {
  ...forgeaxBundlerAdapter(),
  ...(import.meta.env.DEV
    ? { importTransport: createRuntimeAssetImportTransport(runtimeScopeBinding) }
    : {}),
};
const assetPreparation = new WeakMap();

function prepareAssetRegistry(assets) {
  const existing = assetPreparation.get(assets);
  if (existing !== undefined) return existing;
  const pending = (async () => {
    if (import.meta.env.DEV) {
      assets.configureRuntimeBinding(runtimeScopeBinding);
    } else {
      assets.configurePackIndex(new URL('pack-index.json', document.baseURI).href);
    }
    assets.setCatalogSource(assetCatalog);
    if (vfxRuntimeHost !== undefined) {
      assets.installDecoder(vfxGpuEffectContribution.kind, vfxGpuEffectContribution.decoder);
    }
    const catalog = await assets.enumerateCatalog();
    if (!catalog.ok) throw catalog.error;
  })();
  assetPreparation.set(assets, pending);
  return pending;
}

function previewStable(value) {
  if (value instanceof ArrayBuffer) return 'ArrayBuffer:' + JSON.stringify(Array.from(new Uint8Array(value)));
  if (ArrayBuffer.isView(value)) return value.constructor.name + ':' + JSON.stringify(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
  if (Array.isArray(value)) return '[' + value.map(previewStable).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + previewStable(record[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

async function previewDigest(value) {
  const bytes = new TextEncoder().encode(previewStable(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function previewOwnerFacts(assets, resource, payload) {
  if (resource.kind === 'material') {
    const primaryPass = Array.isArray(payload.passes) ? payload.passes[0] : undefined;
    const program = primaryPass?.program?.module;
    const pass = primaryPass?.name;
    return {
      subjectDigest: await previewDigest(payload),
      bindingsDigest: await previewDigest(payload.passes),
      closureDigest: await previewDigest(payload.values ?? payload.passes),
      ...(typeof program === 'string' ? { program } : {}),
      ...(typeof pass === 'string' ? { pass } : {}),
    };
  }
  if (resource.kind === 'mesh') {
    return {
      subjectDigest: await previewDigest(payload),
      vertexDigest: await previewDigest(payload.vertices),
      indexDigest: await previewDigest(payload.indices ?? []),
      submeshDigest: await previewDigest(payload.submeshes),
      aabbDigest: await previewDigest(payload.aabb),
    };
  }
  if (resource.kind === 'texture') {
    const mipCount = typeof payload.mipLevelCount === 'number' ? payload.mipLevelCount : 1;
    const filter = 'linear';
    return {
      subjectDigest: await previewDigest(payload),
      boundDigest: await previewDigest({ width: payload.width, height: payload.height, format: payload.format }),
      uvDigest: await previewDigest({ offset: [0, 0], scale: [1, 1], rotation: 0 }),
      bindingDigest: await previewDigest({ format: payload.format, colorSpace: payload.colorSpace, filter, mipCount }),
      format: payload.format,
      colorSpace: payload.colorSpace,
      filter,
      mipCount,
      dimensions: [payload.width, payload.height],
      payloadClass: 'color',
    };
  }
  return undefined;
}

const gameProjectionDefinitions = new Map();
function registerGameProjection(kind, definition) {
  if (gameProjectionDefinitions.has(definition.id)) {
    throw new Error('forgeax: duplicate game projection id ' + definition.id);
  }
  const entry = { kind, definition };
  gameProjectionDefinitions.set(definition.id, entry);
  return () => {
    if (gameProjectionDefinitions.get(definition.id) === entry) {
      gameProjectionDefinitions.delete(definition.id);
    }
  };
}
const gameProjection = {
  registerAction: (definition) => registerGameProjection('action', definition),
  registerRead: (definition) => registerGameProjection('read', definition),
};
function exposeGameInspection(app) {
  globalThis.__forgeaxGameInspection = {
    list() {
      return {
        reads: Array.from(gameProjectionDefinitions.entries())
          .filter(([, entry]) => entry.kind === 'read')
          .map(([id]) => id),
      };
    },
    async read(id) {
      const entry = gameProjectionDefinitions.get(id);
      if (entry?.kind !== 'read') throw new Error('forgeax: game read projection not found ' + id);
      return entry.definition.read();
    },
    renderer() {
      const inspection = app.renderer.inspect();
      return { state: inspection.state, frameId: inspection.frame.frameId };
    },
  };
}

async function prepareProject(app) {
await prepareAssetRegistry(app.assets);
previewWorld = app.world;
const assets = app.assets;
let canonicalEnvironment;
if (resource !== undefined) {
  if (resource.kind !== 'texture') {
    if (canonicalEnvironmentGuid === null) throw new Error('canonical preview environment is unavailable');
    const environment = await assets.loadByGuid(assets.parseGuid(canonicalEnvironmentGuid));
    if (!environment.ok) throw environment.error;
    if (environment.value.kind !== 'equirect') {
      throw new Error(\`canonical preview environment expected equirect, received \${environment.value.kind}\`);
    }
    if (environment.value.width <= 0 || environment.value.height <= 0 || environment.value.data.byteLength === 0) {
      throw new Error('canonical preview environment must provide decoded equirect pixels');
    }
    canonicalEnvironment = app.world.allocSharedRef('EquirectAsset', environment.value);
  }
  if (resource.kind === 'vfx') {
    if (vfxRuntimeHost === undefined) throw new Error('VFX preview host was not created');
    const attached = await vfxRuntimeHost.attachWorld({ world: app.world, assets });
    if (!attached.ok) throw attached.error;
  }
  const loaded = await assets.loadByGuid(assets.parseGuid(resource.guid));
  if (!loaded.ok) throw loaded.error;
  const payload = loaded.value;
  if (resource.kind === 'vfx' && payload.kind !== 'particle-effect') {
    throw new Error(\`VFX preview expected ParticleEffectAsset, received \${payload.kind}\`);
  }
  const vfxBounds = resource.kind === 'vfx' ? previewVfxBounds(payload) : undefined;
  if (resource.kind === 'vfx' && vfxBounds === undefined) {
    throw new Error('VFX preview owner did not publish finite emitter bounds');
  }
  const meshMaterialHandles = resource.kind === 'mesh' && payload.kind === 'mesh'
    ? await Promise.all(payload.materialSlots.map(async (slot) => {
        if (slot.defaultMaterial === undefined) return 0;
        const material = await assets.loadByGuid(
          assets.parseGuid(AssetGuid.format(slot.defaultMaterial)),
        );
        if (!material.ok) throw material.error;
        if (material.value.kind !== 'material') {
          throw new Error('mesh material slot resolved to a non-material asset');
        }
        return app.world.allocSharedRef('MaterialAsset', material.value);
      }))
    : undefined;
  const meshHandle = resource.kind === 'mesh' && payload.kind === 'mesh'
    ? app.world.allocSharedRef('MeshAsset', payload)
    : app.world.internSharedRef(
        'MeshAsset',
        createPrimitiveMesh(resource.kind === 'texture' ? 'quad' : 'sphere').unwrap(),
      );
  const textureHandle = resource.kind === 'texture' && payload.kind === 'texture'
    ? app.world.allocSharedRef('TextureAsset', payload)
    : undefined;
  if (textureHandle !== undefined && payload.kind === 'texture') {
    const bytes = payload.data instanceof Uint8ClampedArray
      ? new Uint8Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength)
      : payload.data;
    const uploaded = await app.renderer.store.uploadTexture(textureHandle, payload, {
      bytes,
      width: payload.width,
      height: payload.height,
      mime: 'image/png',
      colorSpace: payload.colorSpace,
      mipmap: payload.mipmap,
    });
    if (!uploaded.ok) throw uploaded.error;
  }
  const materialPayload = resource.kind === 'texture' && payload.kind === 'texture'
    ? Materials.unlit([1, 1, 1, 1], { baseColorTexture: textureHandle })
    : resource.kind === 'material' && payload.kind === 'material'
      ? payload
      : undefined;
  const materialHandle = materialPayload === undefined
    ? undefined
    : app.world.allocSharedRef('MaterialAsset', materialPayload);
  const materialBindings = resource.kind === 'mesh'
    ? meshMaterialHandles
    : materialHandle === undefined
      ? undefined
      : [materialHandle];
  const rawAabb = payload.kind === 'mesh' ? payload.aabb : undefined;
  const aabb = rawAabb !== undefined && (Array.isArray(rawAabb) || ArrayBuffer.isView(rawAabb)) && rawAabb.length === 6
    ? Array.from(rawAabb)
    : resource.kind === 'mesh' && payload.kind === 'mesh'
      ? (() => { throw new Error('mesh owner did not publish a finite AABB'); })()
      : [-1, -1, -1, 1, 1, 1];
  const meshFrame = resource.kind === 'mesh'
    ? fitToolPreviewCameraToAabb(aabb, { aspect: 1, fov: Math.PI / 4 })
    : undefined;
  const textureWidth = resource.kind === 'texture' && payload.kind === 'texture' && typeof payload.width === 'number'
    ? Math.max(1, payload.width)
    : 1;
  const textureHeight = resource.kind === 'texture' && payload.kind === 'texture' && typeof payload.height === 'number'
    ? Math.max(1, payload.height)
    : 1;
  const textureAspect = textureWidth / textureHeight;
  const textureScale = textureAspect >= 1
    ? [textureAspect, 1, 1]
    : [1, 1 / textureAspect, 1];
  const center = meshFrame?.center ?? vfxBounds?.center ?? [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2];
  const radius = meshFrame?.radius ?? vfxBounds?.radius ?? Math.max(1, Math.hypot(aabb[3] - aabb[0], aabb[4] - aabb[1], aabb[5] - aabb[2]));
  const texturePreview = resource.kind === 'texture';
  if (resource.kind === 'vfx') {
    const effect = app.world.allocSharedRef('ParticleEffectAsset', payload);
    app.world.spawn(
      { component: Transform, data: { pos: center } },
      { component: ParticleEffectPlayer, data: { effect, playing: true, seed: 0, timeScale: 1 } },
    );
  } else {
    app.world.spawn(
      { component: Transform, data: { pos: center, ...(texturePreview ? { scale: textureScale } : {}) } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: materialBindings === undefined ? {} : { materials: materialBindings } },
    );
  }
  const cameraData = texturePreview
    ? {
        fov: 0,
        aspect: 1,
        near: 0.01,
        far: 100,
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: -textureScale[0] * 0.6,
        right: textureScale[0] * 0.6,
        bottom: -textureScale[1] * 0.6,
        top: textureScale[1] * 0.6,
        tonemap: TONEMAP_NONE,
        antialias: 0,
        bloom: 0,
        clearColor: [0, 0, 0, 1],
      }
    : {
        fov: Math.PI / 4,
        aspect: 1,
        near: meshFrame?.near ?? 0.01,
        far: meshFrame?.far ?? radius * 8,
        tonemap: TONEMAP_REINHARD_EXTENDED,
      };
  const cameraPosition = texturePreview
    ? [0, 0, 5]
    : [center[0], center[1], center[2] + (meshFrame?.distance ?? radius * 2.5)];
  const cameraEntity = app.world.spawn({ component: Camera, data: cameraData }, { component: Transform, data: { pos: cameraPosition } }).unwrap();
  previewCameraEntities.set(app.world, cameraEntity);
  previewCameraTargets.set(app.world, center);
  if (!texturePreview) {
    app.world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -1, -0.3], intensity: 2 } });
    if (canonicalEnvironment === undefined) throw new Error('canonical preview environment was not loaded');
    app.world.spawn({ component: Skylight, data: { equirect: canonicalEnvironment } });
    app.world.spawn({ component: SkyboxBackground, data: { equirect: canonicalEnvironment } });
  }
  const ownerFacts = await previewOwnerFacts(assets, resource, payload);
  const publishedAsset = resource.kind === 'mesh' && payload.kind === 'mesh' && payload.aabb !== undefined
    ? { ...payload, aabb: Array.from(payload.aabb) }
    : payload;
  return {
    kind: resource.kind,
    guid: resource.guid,
    asset: publishedAsset,
    ...(ownerFacts === undefined ? {} : { ownerFacts }),
  };
}
}
const query = new URLSearchParams(location.search);
const recipeValue = query.get('forgeax-tool-recipe');
const snapshotValue = query.get('forgeax-tool-snapshot');
const runIdValue = query.get('forgeax-tool-run-id');
const appState: { current?: App | import('@forgeax/engine/app').ExecutionApp } = {};
let disposeFrontendHost;
let activateGameHost: (() => Promise<void>) | undefined;
const appBootstrapPlugin = {
  name: 'forgeax:generated-app-bootstrap',
  async apply(ctx) {
    const pointerLockAllowed =
      typeof navigator !== 'undefined' && navigator.webdriver === true ? () => false : undefined;
    const result = await createApp(
      canvas,
      workerExecution
        ? {
            context: ctx.root,
            execution: {
              tier: 'engine-worker',
              bootstrap: new URL('./execution-bootstrap.ts', import.meta.url),
              assetCatalog: {
                url: runtimeScopeBinding.catalogUrl,
                expectedScope: runtimeScopeBinding,
                ...(import.meta.env.DEV ? { runtimeBinding: runtimeScopeBinding } : {}),
              },
            },
            ...(pointerLockAllowed === undefined ? {} : { pointerLockAllowed }),
          }
        : {
            context: ctx.root,
            plugins: [${plugins.join(', ')}],
            ...(import.meta.env.DEV ? { assetRuntimeBinding: runtimeScopeBinding } : {}),
            ...(pointerLockAllowed === undefined ? {} : { pointerLockAllowed }),
          },
      workerExecution ? forgeaxBundlerAdapter() : bundler,
    );
    if (!result.ok) throw result.error;
    const app = result.value;
    appState.current = app;
    if (import.meta.env.DEV && !workerExecution) exposeGameInspection(app as App);
    let gameHostFiber;
    const ownsPageLifecycle =
      bootstrapRoot !== 'resource-bootstrap' && resource === undefined && recipeValue === null;
    ctx.effect(
      () => {
        const onPageHide = () => {
          resizeObserver.disconnect();
          if (disposeFrontendHost !== undefined) void disposeFrontendHost();
          else void appState.current?.dispose();
        };
        if (ownsPageLifecycle) window.addEventListener('pagehide', onPageHide, { once: true });
        return async () => {
          if (ownsPageLifecycle) window.removeEventListener('pagehide', onPageHide);
          resizeObserver.disconnect();
          await gameHostFiber?.dispose();
          await app.dispose();
        };
      },
      'devkit/generated-app',
    );
    if (bootstrapRoot !== 'resource-bootstrap' && !workerExecution) {
      activateGameHost = async () => {
        const assets = app.assets;
        if (assets === undefined) throw new Error('forgeax: generated App did not provide assets');
        let defaultScene;
        let defaultSceneRoot;
        const defaultSceneGuid = ${JSON.stringify(facts.defaultScene)};
        if (defaultSceneGuid !== undefined) {
          const loaded = await assets.loadByGuid<SceneAsset>(assets.parseGuid(defaultSceneGuid));
          if (!loaded.ok) throw loaded.error;
          defaultScene = loaded.value;
          const handle = app.world.allocSharedRef('SceneAsset', loaded.value);
          const instantiated = assets.instantiate<SceneAsset>(handle, app.world);
          if (!instantiated.ok) throw instantiated.error;
          defaultSceneRoot = instantiated.value;
        }
        const uiRoot = document.querySelector('#game-ui');
        gameHostFiber = await ctx.root.plugin(gameHostPlugin({
          app,
          assets,
          canvas,
          renderer: app.renderer,
          ...(defaultScene === undefined ? {} : { defaultScene }),
          ...(defaultSceneRoot === undefined ? {} : { defaultSceneRoot }),
          uiRoot: uiRoot instanceof HTMLElement ? uiRoot : document.body,
          setPointerLockAllowed: (allowed) => app.input?.setPointerLockAllowed?.(allowed),
          ...(import.meta.env.DEV ? { gameProjection } : {}),
        }));
      };
    }
  },
};
const hostContext = new Context();
const hostLifecyclePlugin = {
  name: 'forgeax:generated-host-lifecycle',
  apply(ctx) {
    ctx.effect(
      () => async () => {
        hostTransport?.close('generated frontend host disposed');
        if (disposeFrontendHost !== undefined) {
          await disposeFrontendHost();
        } else {
          await appState.current?.dispose();
        }
      },
      'devkit/generated-host-lifecycle',
    );
  },
};
const hostTransport = import.meta.env.DEV
  ? await connectHostWebSocket(
      (location.protocol === 'https:' ? 'wss:' : 'ws:') +
        '//' + location.host + '/__forgeax/host',
    )
  : undefined;
const frontendHost = await createFrontendHost({
  context: hostContext,
  startupPlugins: [hostLifecyclePlugin, appBootstrapPlugin],
  realm: workerExecution ? 'host' : 'engine',
  catalog: pluginCatalog,
  // Keep the provider-only stage on reconnect. The backend may already have
  // promoted the full assembly after a previous browser client, but gameHost
  // is installed only after this first activation and scene bootstrap.
  assembly: selectedInitialAssembly,
  ...(hostTransport === undefined ? {} : { transport: hostTransport }),
  autoActivate: false,
});
disposeFrontendHost = () => frontendHost.dispose();
const app = appState.current;
try {
  if (app === undefined) throw new Error('forgeax: generated App bootstrap did not complete');
  if (bootstrapRoot === 'resource-bootstrap') {
    await frontendHost.activate();
    const pluginLoader = frontendHost.loader;
    if (pluginLoader === undefined) throw new Error('forgeax: frontend host did not install its Loader');
    const pluginProjectionBridge = globalThis.__forgeaxPluginProjection;
    if (pluginProjectionBridge !== undefined) {
      pluginProjectionBridge.current = {
        inspect() {
          const { live } = inspectCatalogPlugins(pluginLoader);
          return { desired: pluginEntries, live, entries: live, liveState: 'attached' };
        },
      };
    }
  } else {
    await frontendHost.activate();
    await activateGameHost?.();
    const finalAssembly = hostTransport === undefined
      ? selectedFrozenAssembly
      : await hostTransport.request(HOST_ASSEMBLY_SERVICE, undefined);
    if (finalAssembly.revision !== frontendHost.assembly.current.revision) {
      await frontendHost.update(finalAssembly);
    }
    const pluginLoader = frontendHost.loader;
    if (pluginLoader === undefined) throw new Error('forgeax: frontend host did not install its Loader');
    const pluginProjectionBridge = globalThis.__forgeaxPluginProjection;
    if (pluginProjectionBridge !== undefined) {
      pluginProjectionBridge.current = {
        inspect() {
          const { live } = inspectCatalogPlugins(pluginLoader);
          return { desired: pluginEntries, live, entries: live, liveState: 'attached' };
        },
      };
    }
  }
} catch (error) {
  await frontendHost.dispose().catch(() => {});
  throw error;
}

if (query.has('forgeax-tool-replay')) {
  globalThis.__forgeaxToolReplayHost = {
    ready: true,
    async run(capture) {
      const result = await replayToolPreviewCapture(capture);
      return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.error };
    },
  };
} else if (recipeValue !== null) {
  const previewRecipe = createToolPreviewRecipe(JSON.parse(recipeValue));
  const host = await createToolPreviewHost({
    ...(runIdValue === null ? {} : { runId: runIdValue }),
    recipe: previewRecipe,
    snapshot: JSON.parse(snapshotValue ?? 'null'),
    ...(resource === undefined ? {} : { resource }),
    canvas,
    app: {
      plugins: [${plugins.join(', ')}],
      ...(vfxRuntimeHost === undefined ? {} : { features: [vfxRuntimeHost.feature] }),
    },
    bundler,
    prepare: prepareProject,
    collectResourceFacts(app, current) {
      if (current === undefined) return current;
      if (resource?.kind !== 'vfx') {
        if (resource?.kind === 'material' || resource?.kind === 'mesh' || resource?.kind === 'texture') {
          if (resource.kind === 'mesh') {
            const asset = current.asset;
            const aabb = asset?.aabb;
            const submeshes = asset?.submeshes;
            const materialSlots = asset?.materialSlots;
            if (!Array.isArray(aabb) || aabb.length !== 6 || !Array.isArray(submeshes) || !Array.isArray(materialSlots)) {
              return current;
            }
            return {
              ...current,
              observation: {
                ...current.ownerFacts,
                aabb,
                submeshCount: submeshes.length,
                materialSlotCount: materialSlots.length,
              },
            };
          }
          return {
            ...current,
            observation: current.ownerFacts,
          };
        }
        return current;
      }
      if (vfxRuntimeHost === undefined) return current;
      const hostInspection = vfxRuntimeHost.inspect(app.world);
      const player = hostInspection?.players[0];
      const renderObservation = vfxRuntimeHost.feature.inspect();
      if (player === undefined || renderObservation.frameNumber < 0) {
        return current;
      }
      const bounds = previewVfxBounds(current.asset);
      if (bounds === undefined) return current;
      const emitterDigest = JSON.stringify(player.emitters.map(({ id, module, capacity }) => ({ id, module, capacity })));
      const sampleDigest = JSON.stringify(player.emitters.map(({ id, schedule }) => ({ id, schedule })));
      const boundsDigest = JSON.stringify(player.emitters.map(({ id, bounds: emitterBounds }) => ({ id, bounds: emitterBounds })));
      const computeDigest = player.programFingerprint;
      const indirectDigest = JSON.stringify(player.emitters.map(({ id, renderers }) => ({ id, renderers: renderers.map(({ kind, enabled }) => ({ kind, enabled })) })));
      return {
        ...current,
        observation: {
          subjectDigest: current.asset.programFingerprint,
          programFingerprint: player.programFingerprint,
          emitterDigest,
          sampleDigest,
          boundsDigest,
          computeDigest,
          indirectDigest,
          authoredBounds: bounds.aabb,
          seed: player.seed,
          fixedDelta: player.fixedDelta,
          timelineFrames: previewRecipe.frames,
          dispatches: renderObservation.dispatches,
          indirectDraws: renderObservation.indirectDraws,
          subjectOutputs: renderObservation.subjectOutputs,
        },
      };
    },
    onDispose: async () => {
      if (vfxRuntimeHost === undefined || previewWorld === undefined) return;
      const detached = await vfxRuntimeHost.detachWorld({ world: previewWorld });
      if (!detached.ok) throw detached.error;
    },
    executeAction(action) {
      return !globalThis.dispatchEvent(new CustomEvent('forgeax-tool-action', {
        detail: action,
        cancelable: true,
      }));
    },
  });
  if (!host.ok) {
    globalThis.__forgeaxToolHost = {
      ready: true,
      capture: async () => ({ ok: false, error: host.error }),
      run: async () => ({ ok: false, error: host.error }),
      dispose: async () => undefined,
    };
  } else {
    globalThis.__forgeaxToolHost = {
      ready: true,
      async capture() {
        const result = await host.value.capture();
        return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.error };
      },
      async run() {
        const result = await host.value.run();
        return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.error };
      },
      dispose: () => host.value.dispose(),
    };
    window.addEventListener('pagehide', () => void host.value.dispose(), { once: true });
  }
} else {
  app.start().unwrap();
  if (query.has('forgeaxCapture')) {
    document.documentElement.dataset.forgeaxCaptureReady = 'true';
  }
}
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
    }
    return character;
  });
}

function htmlSource(title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:," />
    <title>${escapeHtml(title)}</title>
    <style>
      html, body, #app-shell, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: #05070b; }
      #app { display: block; }
      #app-shell { position: relative; }
      #game-ui { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      #forgeax-fatal { position: fixed; inset: 0; z-index: 2147483647; display: none; place-items: center; padding: 24px; background: #0b0d10; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="app-shell"><canvas id="app"></canvas><div id="game-ui"></div></div><div id="forgeax-fatal" role="alert"></div>
    <script>
      (() => {
        const appendStructuredFailure = (value, prefix, depth, seen, lines) => {
          if (value === null || typeof value !== 'object' || depth > 3) return;
          if (seen.has(value)) {
            lines.push((prefix || 'cause') + ': [circular]');
            return;
          }
          seen.add(value);
          const record = value;
          const name = typeof record.name === 'string' && record.name.length > 0
            ? record.name
            : undefined;
          const code = typeof record.code === 'string' && record.code.length > 0
            ? record.code
            : undefined;
          const message = typeof record.message === 'string' && record.message.length > 0
            ? record.message
            : undefined;
          if (name !== undefined || code !== undefined || message !== undefined) {
            const identity = [name || 'Error', code].filter(Boolean).join(' ');
            lines.push((prefix ? prefix + ': ' : '') + identity + (message ? ': ' + message : ''));
          }
          for (const key of ['expected', 'hint', 'reason']) {
            if (typeof record[key] === 'string' && record[key].length > 0) {
              lines.push((prefix ? prefix + '.' : '') + key + ': ' + record[key]);
            }
          }
          for (const key of ['cause', 'detail', 'failure', 'webgpuError', 'wgpuError', 'error']) {
            const nested = record[key];
            const nestedPrefix = (prefix ? prefix + '.' : '') + key;
            if (nested !== null && typeof nested === 'object') {
              appendStructuredFailure(nested, nestedPrefix, depth + 1, seen, lines);
            } else if (typeof nested === 'string' && nested.length > 0) {
              lines.push(nestedPrefix + ': ' + nested);
            }
          }
        };
        const formatStartupFailure = (reason) => {
          if (reason !== null && typeof reason === 'object') {
            const lines = [];
            appendStructuredFailure(reason, '', 0, new Set(), lines);
            if (lines.length > 0) return lines.join('\\n');
            try {
              return JSON.stringify(reason) || 'Unknown structured startup failure';
            } catch {
              return 'Unserializable structured startup failure';
            }
          }
          return String(reason ?? 'Unknown startup failure');
        };
        const show = (reason) => {
          const notice = document.querySelector('#forgeax-fatal');
          if (!(notice instanceof HTMLElement)) return;
          let message = formatStartupFailure(reason);
          if (/webgpu|adapter-unavailable|no usable (rendering )?backend/i.test(message)) {
            message += '\\n\\nRenderer diagnosis: ForgeaX supports browser WebGPU and a wgpu/WebGL2 fallback. This failure alone does not prove that WebGPU is unsupported; use the structured code, hint, and nested backend causes above.';
          }
          notice.textContent = 'ForgeaX game failed to start.\\n' + message;
          notice.style.display = 'grid';
        };
        window.addEventListener('error', (event) => show(event.error ?? event.message));
        window.addEventListener('unhandledrejection', (event) => show(event.reason));
      })();
    </script>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`;
}

async function materializeViteDevPort(port: number): Promise<number> {
  if (port !== 0) return port;
  const reservation = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    reservation.once('error', rejectListen);
    reservation.listen(0, '127.0.0.1', resolveListen);
  });
  const address = reservation.address();
  const assigned = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, rejectClose) => {
    reservation.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  if (assigned === 0) throw new Error('OS did not assign an ephemeral preview port');
  return assigned;
}

/** Run one DevKit command as a Cordis-owned business plugin. */
export async function buildProjectWithHost(
  options: BuildOptions = {},
): Promise<CommandResult<unknown>> {
  let result: CommandResult<unknown> | undefined;
  let host: BackendHost | undefined;
  try {
    host = await createBackendHost({
      startupPlugins: [
        {
          name: 'forgeax:devkit-build',
          async apply() {
            const facts = await readProjectFacts(options.root);
            if (!facts.ok) {
              result = facts;
              return;
            }
            const previous = process.cwd();
            const base = options.base ?? '/';
            const outDir = resolve(facts.value.root, options.outDir ?? 'dist');
            try {
              process.chdir(facts.value.root);
              await viteBuild(await createViteConfig(facts.value, 'build', base, { outDir }));
              result = { ok: true, value: await writeDistManifest(facts.value, base, outDir) };
            } catch (cause) {
              result = { ok: false, error: commandError(cause, 'game-build-failed') };
            } finally {
              process.chdir(previous);
            }
          },
        },
      ],
    });
    return (
      result ?? {
        ok: false,
        error: {
          code: 'game-build-failed',
          expected: 'the DevKit build plugin to publish a result',
          hint: 'Inspect the DevKit host startup diagnostics.',
          detail: {},
        },
      }
    );
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'game-build-failed') };
  } finally {
    await host?.dispose();
  }
}

/** Start the Vite development service under one backend Host business plugin. */
export async function startDevProjectWithHost(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  let result: CommandResult<unknown> | undefined;
  let started = false;
  let host: BackendHost | undefined;
  try {
    host = await createBackendHost({
      startupPlugins: [
        {
          name: 'forgeax:devkit-dev-server',
          async apply(ctx) {
            const facts = await readProjectFacts(options.root);
            if (!facts.ok) {
              result = facts;
              return;
            }
            const previous = process.cwd();
            let changedDirectory = false;
            let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
            let closed = false;
            const closeServer = async (): Promise<void> => {
              if (closed) return;
              closed = true;
              await server?.close();
              if (changedDirectory) process.chdir(previous);
            };
            try {
              const port = resolveProjectPort(options.port);
              const vitePort = {
                ...port,
                host: '127.0.0.1' as const,
                port: await materializeViteDevPort(port.port),
              };
              process.chdir(facts.value.root);
              changedDirectory = true;
              server = await createViteServer(
                await createViteConfig(facts.value, 'serve', '/', { server: vitePort }),
              );
              ctx.effect(() => closeServer, 'devkit/dev-server');
              await server.listen(vitePort.port);
              if (options.json !== true) server.printUrls();
              result = {
                ok: true,
                value: {
                  root: facts.value.root,
                  urls: server.resolvedUrls,
                  mode: 'dev',
                  serves: 'source',
                  capabilities: {
                    'rhi.capture': {
                      available: false,
                      realm: 'host',
                      reason: 'standalone-dev-server-has-no-live-app-cli-attachment',
                    },
                  },
                },
              };
              started = true;
            } catch (cause) {
              await closeServer().catch(() => {});
              result = { ok: false, error: commandError(cause, 'dev-server-failed') };
            }
          },
        },
      ],
    });
    const finalResult =
      result ??
      ({
        ok: false,
        error: {
          code: 'dev-server-failed',
          expected: 'the DevKit development plugin to publish a result',
          hint: 'Inspect the DevKit host startup diagnostics.',
          detail: {},
        },
      } satisfies CommandResult<unknown>);
    if (started) activeDevKitHosts.add(host);
    else await host.dispose();
    return finalResult;
  } catch (cause) {
    await host?.dispose();
    return { ok: false, error: commandError(cause, 'dev-server-failed') };
  }
}

/** Start static dist preview under one DevKit plugin and verify its manifest first. */
export async function startPreviewProjectWithHost(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  let result: CommandResult<unknown> | undefined;
  let started = false;
  let host: BackendHost | undefined;
  try {
    host = await createBackendHost({
      startupPlugins: [
        {
          name: 'forgeax:devkit-preview-server',
          async apply(ctx) {
            const root = resolve(options.root ?? process.cwd());
            const verified = await verifyDist(resolve(root, 'dist'));
            if (!verified.ok) {
              result = verified;
              return;
            }
            try {
              const port = resolveProjectPort(options.port);
              const server = await vitePreview({
                root,
                configFile: false,
                base: verified.value.base,
                preview: { open: false, ...port },
                build: { outDir: resolve(root, 'dist') },
              });
              ctx.effect(() => () => server.close(), 'devkit/preview-server');
              if (options.json !== true) server.printUrls();
              result = {
                ok: true,
                value: {
                  root,
                  urls: server.resolvedUrls,
                  mode: 'preview',
                  serves: 'dist',
                  capabilities: {
                    'rhi.capture': {
                      available: false,
                      realm: 'host',
                      reason: 'static-dist-host-does-not-install-dev-capture',
                    },
                  },
                },
              };
              started = true;
            } catch (cause) {
              result = { ok: false, error: commandError(cause, 'preview-server-failed') };
            }
          },
        },
      ],
    });
    const finalResult =
      result ??
      ({
        ok: false,
        error: {
          code: 'preview-server-failed',
          expected: 'the DevKit preview plugin to publish a result',
          hint: 'Inspect the DevKit host startup diagnostics.',
          detail: {},
        },
      } satisfies CommandResult<unknown>);
    if (started) activeDevKitHosts.add(host);
    else await host.dispose();
    return finalResult;
  } catch (cause) {
    await host?.dispose();
    return { ok: false, error: commandError(cause, 'preview-server-failed') };
  }
}

export async function createViteConfig(
  facts: ProjectFacts,
  command: 'serve' | 'build',
  base = '/',
  options: {
    readonly bootstrapRoot?: BootstrapRoot;
    readonly outDir?: string;
    readonly server?: ProjectPortOptions;
  } = {},
): Promise<InlineConfig> {
  const bootstrapRoot = options.bootstrapRoot ?? 'project-bootstrap';
  // The canonical kit ships the engine's default environment (sky.hdr equirect).
  // Authored scenes (e.g. the default game template) reference it as a Skylight /
  // SkyboxBackground dependency, so a self-contained standalone build must catalog
  // it on the game path too — not only the tool-preview (resource-bootstrap) path.
  const canonicalKit = await resolveCanonicalKit();
  const generated = resolve(facts.root, '.forgeax', 'generated');
  await mkdir(generated, { recursive: true });
  const projectRoots = facts.assetRoots.map((root) => resolve(facts.root, root));
  const ignorePath =
    bootstrapRoot === 'resource-bootstrap'
      ? isResourcePreviewIgnoredPath
      : isProjectSourceIgnoredPath;
  const builtinPack = await prepareBuiltinPack(projectRoots, generated, ignorePath);
  const materialPackages = await discoverMaterialPackages(projectRoots, ignorePath);
  await Promise.all([
    writeFile(resolve(generated, 'index.html'), htmlSource(facts.name)),
    writeFile(resolve(generated, 'main.ts'), hostSource(facts, bootstrapRoot, canonicalKit?.guid)),
    writeFile(
      resolve(generated, 'execution-bootstrap.ts'),
      executionBootstrapSource(facts, generated),
    ),
  ]);
  const roots = [
    ...projectRoots,
    ...(builtinPack === undefined ? [] : [builtinPack]),
    ...(canonicalKit === undefined ? [] : [canonicalKit.root]),
  ];
  const engineWorkspaceRoot = findEngineWorkspaceRoot();
  const runtimeBinding = createStandaloneRuntimeAssetBinding(facts.id);
  const engineWorkspaceResolver = await createEngineWorkspaceResolver(facts.root);
  const consumerAliases = await consumerEngineAliases(facts.root);
  const plugins: Plugin[] = [
    ...(engineWorkspaceResolver === undefined ? [] : [engineWorkspaceResolver]),
    ...(command === 'serve' ? [devKitHostBridge(facts, bootstrapRoot)] : []),
    ...(command === 'serve' && process.env.FORGEAX_ENGINE_RHI_DEBUG === '1'
      ? [vitePluginRhiDebug({ rootDir: facts.root }) as Plugin]
      : []),
    forgeaxShader({ materialPackages }) as Plugin,
    pluginPack({
      roots,
      runtimeBinding,
      ddc: devKitDdcRoots(facts.root),
      refresh: command === 'serve' ? reloadAssetHost() : undefined,
      importers: DEFAULT_IMPORTERS,
      cookers: [createMaterialPackCooker(roots), createParticleCodeNativeCookerFromRoots(roots)],
      ignorePath,
    }) as Plugin,
  ];
  return {
    root: generated,
    base,
    configFile: false,
    publicDir: false,
    plugins,
    resolve: {
      alias: consumerAliases,
      dedupe: ['@forgeax/engine'],
    },
    server: {
      ...options.server,
      fs: {
        allow: [
          facts.root,
          ...roots,
          ...(engineWorkspaceRoot === undefined ? [] : [engineWorkspaceRoot]),
        ],
      },
    },
    build: {
      target: 'esnext',
      outDir: options.outDir ?? resolve(facts.root, 'dist'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(generated, 'index.html') },
    },
  };
}
