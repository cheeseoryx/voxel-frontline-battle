import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['game/server/source/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'game/server/dist/index.js',
  logLevel: 'info',
})
