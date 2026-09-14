import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const sourceRoot = resolve(root, 'packages/shader/src');
const inputIndex = process.argv.indexOf('--input');
const inputRoot = resolve(
  root,
  inputIndex >= 0
    ? (process.argv[inputIndex + 1] ?? 'shared-build-inputs-release')
    : 'shared-build-inputs-release',
);
const outputIndex = process.argv.indexOf('--output');
const outputRoot = resolve(
  root,
  outputIndex >= 0
    ? (process.argv[outputIndex + 1] ?? 'packages/vite-plugin-shader/dist/engine-inputs')
    : 'packages/vite-plugin-shader/dist/engine-inputs',
);
const importPattern = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m;

const imports = {};
for (const name of (await readdir(sourceRoot)).filter((entry) => entry.endsWith('.wgsl')).sort()) {
  const source = await readFile(resolve(sourceRoot, name), 'utf8');
  const identifier = importPattern.exec(source)?.[1];
  if (identifier !== undefined) imports[identifier] = source;
}

const defaultSurfaceSource = imports['forgeax_material::default_standard_surface'];
if (defaultSurfaceSource === undefined) {
  throw new Error('default_standard_surface is missing from the shader import source catalog');
}
const standardTemplate = await readFile(resolve(sourceRoot, 'default-standard-pbr.wgsl'), 'utf8');
const surfaceSlotModule = /^\s*#import\s+([A-Za-z0-9_.:-]+::slot::surface)::/m.exec(
  standardTemplate,
)?.[1];
if (surfaceSlotModule === undefined) {
  throw new Error('Standard shader does not declare the canonical surface slot import');
}
imports[surfaceSlotModule] = defaultSurfaceSource.replace(
  /^\s*#define_import_path\s+[^\n]+/m,
  `#define_import_path ${surfaceSlotModule}`,
);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const profiles = ['base-base', 'point-base', 'base-ssao', 'point-ssao'];
await Promise.all(
  profiles.map(async (profile) => {
    const target = resolve(outputRoot, profile);
    await mkdir(target, { recursive: true });
    await Promise.all([
      cp(resolve(inputRoot, profile, 'shaders/manifest.json'), resolve(target, 'manifest.json')),
      writeFile(resolve(target, 'imports.json'), `${JSON.stringify(imports, null, 2)}\n`),
    ]);
  }),
);

process.stdout.write(
  `${JSON.stringify({ outputRoot, profiles, imports: Object.keys(imports).length }, null, 2)}\n`,
);
