import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forgeaxShader } from '../index.js';

interface EmittedAsset {
  readonly type: 'asset';
  readonly fileName: string;
  readonly source: string;
}

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

function mockContext(): { emitted: EmittedAsset[]; emitFile: (asset: EmittedAsset) => string } {
  const emitted: EmittedAsset[] = [];
  return {
    emitted,
    emitFile(asset) {
      emitted.push(asset);
      return asset.fileName;
    },
  };
}

describe('user material shader variant manifest', () => {
  it('can compile Pack-owned materials without publishing a second runtime entry', async () => {
    const sourcePath = resolve(
      repoRoot,
      'apps/learn-render/4.advanced-opengl/3.blending/src/alpha-test.wgsl',
    );
    const source = await readFile(sourcePath, 'utf8');
    const plugin = forgeaxShader({
      engineEntries: false,
      publishAuthoredMaterialShaders: false,
      materialPackages: [
        resolve(
          repoRoot,
          'apps/learn-render/4.advanced-opengl/3.blending/src/alpha-test.pack.json',
        ),
      ],
    });
    const ctx = mockContext();
    await plugin.buildStart?.call(ctx as never);
    const transformed = await plugin.transform?.call(ctx as never, source, sourcePath);
    expect(transformed?.code).toContain('MaterialParameters');
    plugin.generateBundle?.call(ctx as never);

    const manifestAsset = ctx.emitted.find((asset) => asset.fileName === 'shaders/manifest.json');
    expect(manifestAsset).toBeDefined();
    if (manifestAsset === undefined) return;
    const manifest = JSON.parse(manifestAsset.source) as {
      entries: Array<{ hash: string }>;
      materialShaders: Array<{ identifier: string }>;
    };
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(manifest.materialShaders).not.toContainEqual(
      expect.objectContaining({ identifier: 'learn_render::alpha_test' }),
    );
  });

  it('refreshes authored material entries when the provider switches active games', async () => {
    const alphaPack = resolve(
      repoRoot,
      'apps/learn-render/4.advanced-opengl/3.blending/src/alpha-test.pack.json',
    );
    const blinnPhongPack = resolve(
      repoRoot,
      'apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/blinn-phong.pack.json',
    );
    let activePack = alphaPack;
    const plugin = forgeaxShader({
      engineEntries: false,
      materialPackagesProvider: () => [activePack],
    });
    const middleware: Array<(req: unknown, res: unknown, next: () => void) => Promise<void>> = [];
    const server = {
      config: { base: '/' },
      middlewares: {
        use(handler: (req: unknown, res: unknown, next: () => void) => Promise<void>) {
          middleware.push(handler);
        },
      },
      transformRequest: async () => null,
    };
    plugin.configureServer?.(server as never);
    await plugin.buildStart?.call({} as never);

    const readManifest = async (): Promise<{
      materialShaders: Array<{ identifier: string }>;
    }> => {
      let body = '';
      const response = {
        setHeader() {},
        end(value: string) {
          body = value;
        },
      };
      await middleware[0]?.({ url: '/shaders/manifest.json' }, response, () => {});
      return JSON.parse(body) as { materialShaders: Array<{ identifier: string }> };
    };

    const first = await readManifest();
    expect(first.materialShaders.map((entry) => entry.identifier)).toContain(
      'learn_render::alpha_test',
    );

    activePack = blinnPhongPack;
    const second = await readManifest();
    expect(second.materialShaders.map((entry) => entry.identifier)).toEqual([
      'learn_render::5_1_blinn_phong',
    ]);
  });

  it('compiles both WEBGL2_COMPAT branches and inlines them into materialShaders[]', async () => {
    const sourcePath = resolve(
      repoRoot,
      'apps/learn-render/4.advanced-opengl/3.blending/src/alpha-test.wgsl',
    );
    const source = await readFile(sourcePath, 'utf8');

    const plugin = forgeaxShader({
      engineEntries: false,
      materialPackages: [
        resolve(
          repoRoot,
          'apps/learn-render/4.advanced-opengl/3.blending/src/alpha-test.pack.json',
        ),
      ],
    });
    const ctx = mockContext();
    await plugin.buildStart?.call(ctx as never);
    await plugin.transform?.call(ctx as never, source, sourcePath);
    plugin.generateBundle?.call(ctx as never);

    const manifestAsset = ctx.emitted.find((asset) => asset.fileName === 'shaders/manifest.json');
    expect(manifestAsset).toBeDefined();
    if (manifestAsset === undefined) return;
    const manifest = JSON.parse(manifestAsset.source) as {
      materialShaders: Array<{
        identifier: string;
        sourcePath: string;
        composedWgsl: string;
        variants: Array<{
          definesKey: string;
          defines: Record<string, boolean>;
          composedWgsl: string;
        }>;
      }>;
    };
    const entry = manifest.materialShaders.find(
      (item) => item.identifier === 'learn_render::alpha_test',
    );
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.sourcePath).toContain('alpha-test.wgsl');
    expect(entry.composedWgsl).toContain('discard');
    expect(entry.variants).toHaveLength(4);
    const webgl = entry.variants.find(
      (variant) =>
        variant.defines.WEBGL2_COMPAT === true &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === false,
    );
    const webgpu = entry.variants.find(
      (variant) =>
        variant.defines.WEBGL2_COMPAT === false &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === true,
    );
    const primary = entry.variants.find(
      (variant) =>
        variant.defines.WEBGL2_COMPAT === true && variant.defines.STORAGE_BUFFER_AVAILABLE === true,
    );
    expect(webgl?.definesKey).toBe('STORAGE_BUFFER_AVAILABLE=false+WEBGL2_COMPAT=true');
    expect(webgpu?.definesKey).toBe('STORAGE_BUFFER_AVAILABLE=true+WEBGL2_COMPAT=false');
    expect(webgl?.composedWgsl).toContain('textureSampleLevel');
    expect(webgpu?.composedWgsl).toContain('textureSample');
    expect(webgpu?.composedWgsl).not.toContain('textureSampleLevel');
    expect(entry.composedWgsl).toBe(primary?.composedWgsl);
  });

  it('infers the storage-buffer capability axis for mesh-importing custom shaders', async () => {
    const sourcePath = resolve(
      repoRoot,
      'apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/blinn-phong.wgsl',
    );
    const source = await readFile(sourcePath, 'utf8');

    const plugin = forgeaxShader({
      engineEntries: false,
      materialPackages: [
        resolve(
          repoRoot,
          'apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/blinn-phong.pack.json',
        ),
      ],
    });
    const ctx = mockContext();
    await plugin.buildStart?.call(ctx as never);
    await plugin.transform?.call(ctx as never, source, sourcePath);
    plugin.generateBundle?.call(ctx as never);

    const manifestAsset = ctx.emitted.find((asset) => asset.fileName === 'shaders/manifest.json');
    expect(manifestAsset).toBeDefined();
    if (manifestAsset === undefined) return;
    const manifest = JSON.parse(manifestAsset.source) as {
      materialShaders: Array<{
        identifier: string;
        variants: Array<{
          definesKey: string;
          defines: Record<string, boolean>;
          composedWgsl: string;
        }>;
      }>;
    };
    const entry = manifest.materialShaders.find(
      (item) => item.identifier === 'learn_render::5_1_blinn_phong',
    );
    expect(entry?.variants).toHaveLength(2);
    expect(entry?.variants.map((variant) => variant.defines.STORAGE_BUFFER_AVAILABLE)).toEqual([
      true,
      false,
    ]);
    expect(
      entry?.variants.find((variant) => variant.defines.STORAGE_BUFFER_AVAILABLE === false)
        ?.composedWgsl,
    ).toMatch(/@group\(2\)\s+@binding\(0\)\s+var<uniform> meshes/);
  });

  it('cooks skinned Standard transmission roots with the shared mesh ABI retained', async () => {
    const sourcePath = resolve(repoRoot, 'packages/shader/src/default-standard-pbr-skin.wgsl');
    const source = await readFile(sourcePath, 'utf8');
    const fullPack = resolve(
      repoRoot,
      'apps/hello/physical-material/src/skin-full-physical.pack.json',
    );
    const clearcoatPack = resolve(
      repoRoot,
      'apps/hello/physical-material/src/skin-clearcoat-factor-r.pack.json',
    );

    const compilePack = async (pack: string) => {
      const plugin = forgeaxShader({ engineEntries: false, materialPackages: [pack] });
      const context = mockContext();
      await plugin.buildStart?.call(context as never);
      await plugin.transform?.call(context as never, source, sourcePath);
      plugin.generateBundle?.call(context as never);
      const manifestAsset = context.emitted.find(
        (asset) => asset.fileName === 'shaders/manifest.json',
      );
      expect(manifestAsset).toBeDefined();
      if (manifestAsset === undefined) throw new Error('shader manifest was not emitted');
      const manifest = JSON.parse(manifestAsset.source) as {
        materialShaders: Array<{
          identifier: string;
          paramSchema: string;
          composedWgsl: string;
          variants: Array<{ defines: Record<string, boolean>; composedWgsl: string }>;
        }>;
      };
      const row = manifest.materialShaders.find((entry) =>
        entry.identifier.startsWith('physical-material::pbr-skin-'),
      );
      if (row === undefined) throw new Error('skinned physical material row was not emitted');
      return row;
    };

    const full = await compilePack(fullPack);
    const clearcoat = await compilePack(clearcoatPack);
    const fullSchema = JSON.parse(full.paramSchema) as Array<{ name: string }>;
    const clearcoatSchema = JSON.parse(clearcoat.paramSchema) as Array<{ name: string }>;
    expect(fullSchema.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'transmission',
        'ior',
        'thickness',
        'attenuationColor',
        'attenuationDistance',
        'transmissionTexture',
        'thicknessTexture',
      ]),
    );
    expect(clearcoatSchema.map((entry) => entry.name)).not.toContain('transmissionTexture');
    expect(full.composedWgsl).toContain('transmissionTexture');
    expect(full.composedWgsl).toContain('transmissionBasis0');
    expect(full.composedWgsl).toMatch(/@group\(2\)\s*@binding\(0\)/u);
    expect(full.composedWgsl).toMatch(/@group\(3\)\s*@binding\(0\)/u);
    expect(clearcoat.composedWgsl).not.toContain('transmissionBasis0');
    expect(full.variants.length).toBeGreaterThan(0);
    expect(
      full.variants.every((variant) => variant.composedWgsl.includes('transmissionTexture')),
    ).toBe(true);
  }, 120_000);
});
