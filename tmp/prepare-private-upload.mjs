import fs from 'node:fs';
import path from 'node:path';
const source='F:/voxel-frontline-battle/forgeax';
const target='F:/ForgeaX/forgeax-voxel-game';
const write=(p,s)=>{fs.mkdirSync(path.dirname(path.join(target,p)),{recursive:true});fs.writeFileSync(path.join(target,p),s);};
// The cloned demo is tracked and recoverable from its existing Git history.
const assets=path.resolve(target,'assets');
if(assets!=='F:\\ForgeaX\\forgeax-voxel-game\\assets')throw Error('Unexpected destination');
fs.rmSync(assets,{recursive:true});
for(const dir of ['assets','docs','skills','third-party'])fs.cpSync(path.join(source,dir),path.join(target,dir),{recursive:true});
for(const file of ['forge.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc','.gitignore','tsconfig.json','vitest.config.ts'])fs.copyFileSync(path.join(source,file),path.join(target,file));
for(const file of fs.readdirSync(path.join(source,'scripts'))){if(/^(import-|audit-original|verify-original)/.test(file))continue;fs.cpSync(path.join(source,'scripts',file),path.join(target,'scripts',file),{recursive:true});}
const p=JSON.parse(fs.readFileSync(path.join(source,'package.json')));
p.name='@forgeax/voxel-frontline';p.description='Voxel Frontline warfare game running natively on ForgeaX Engine';
p.scripts={...p.scripts,dev:'pnpm dev:portal','dev:portal':'node scripts/portal-server.mjs','dev:game':'node scripts/game-server.mjs','serve:game':'node scripts/serve-dist.mjs','serve:path-gateway':'node scripts/path-gateway.mjs',check:'pnpm typecheck','verify:structure':'node scripts/verify-structure.mjs'};
for(const key of ['engine:local','engine:build','verify:original','import:original'])delete p.scripts[key];
p.dependencies['@forgeax/voxel']='workspace:*';p.devDependencies['@forgeax/voxel-tools']='workspace:*';
write('package.json',JSON.stringify(p,null,2)+'\n');
const ts=JSON.parse(fs.readFileSync(path.join(source,'tsconfig.json')));delete ts.compilerOptions.paths;write('tsconfig.json',JSON.stringify(ts,null,2)+'\n');
write('vitest.config.ts',"import {defineConfig} from 'vitest/config';\nexport default defineConfig({test:{name:'voxel-frontline',environment:'node',include:['assets/**/__tests__/**/*.test.ts']}});\n");
write('pnpm-workspace.yaml','packages:\n  - .\n  - vendor/forgeax-voxel/packages/*\n'+fs.readFileSync(path.join(source,'pnpm-workspace.yaml'),'utf8'));
const fixtures=['js/vendor/three.gltf.global.js','js/economy.js',...['ai','economy','tdm-match','ffa-match','gg-match','sd-match'].map(f=>'modes/small-battle/js/'+f+'.js')];
for(const f of fixtures){const dest=path.join(target,'test-fixtures/original',f);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(source,'..',f),dest);}
for(const f of ['original-ai.test.ts','original-match.test.ts','rules-and-voxel.test.ts']){const dest=path.join(target,'assets/gameplay/__tests__',f);let text=fs.readFileSync(dest,'utf8');text=text.replaceAll("'../js/","'test-fixtures/original/js/").replaceAll("'../modes/","'test-fixtures/original/modes/");fs.writeFileSync(dest,text);}
for(const f of fs.readdirSync(path.join(target,'scripts')).filter(f=>f.startsWith('check-')&&f.endsWith('.cjs'))){const dest=path.join(target,'scripts',f);let text=fs.readFileSync(dest,'utf8').replaceAll("'http://localhost:8766/'","(process.env.GAME_URL||'http://localhost:5182/')");fs.writeFileSync(dest,text);}
let preview=fs.readFileSync(path.join(target,'scripts/start-preview.ps1'),'utf8').replace('[int]$Port=8766','[int]$Port=5182');write('scripts/start-preview.ps1',preview);
let server=fs.readFileSync(path.join(target,'scripts/game-server.mjs'),'utf8').replace("const forgeax = resolve(root, 'node_modules/.bin/forgeax');","const forgeax = resolve(root, 'scripts/forgeax-tool.mjs');").replace("spawn(forgeax, ['dev', '--port', String(upstreamPort)]","spawn(process.execPath, [forgeax, 'dev', 'start', '--port', String(upstreamPort)]").replace("cwd: root,\n  env:","cwd: root,\n  windowsHide: true,\n  env:");write('scripts/game-server.mjs',server);
let staticServer=fs.readFileSync(path.join(target,'scripts/serve-dist.mjs'),'utf8').replace("file.endsWith('/index.html')","file === resolve(dist, 'index.html')");write('scripts/serve-dist.mjs',staticServer);
write('.gitignore',fs.readFileSync(path.join(source,'.gitignore'),'utf8')+'\n.env\n.env.*\n!.env.example\n*.pem\n*.key\n');
write('启动体素战争.cmd','@echo off\r\ncd /d "%~dp0"\r\ncall pnpm preview:windows\r\npause\r\n');
console.log('Copied native game and portable test fixtures.');
