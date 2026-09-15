import * as esbuild from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

await esbuild.build({
  entryPoints: ['game/client/source/bootstrap.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: 'js/zaohua-online.js',
  logLevel: 'info',
})

await esbuild.build({
  entryPoints: ['game/server/source/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'game/server/dist/index.js',
  logLevel: 'info',
})

const dist = 'dist'
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const copies = ['index.html', 'style.css', 'styles', 'js', 'assets', 'modes']
for (const item of copies) {
  await cp(item, join(dist, item), {
    recursive: true,
    filter: (source) => !source.includes(`${join('assets', 'Anims')}`) && !source.includes(`${join('assets', 'Roles')}`),
  })
}
