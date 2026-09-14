import {spawn} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
const environment={...process.env};
if(args[0]==='project'&&['build','package'].includes(args[1]))environment.NODE_ENV='production';
const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
if(!environment.FORGEAX_BROWSER_EXECUTABLE&&existsSync(chrome))environment.FORGEAX_BROWSER_EXECUTABLE=chrome;
const bindingPath=resolve(root,'.forgeax/engine-binding.json');
const binding=existsSync(bindingPath)?JSON.parse(readFileSync(bindingPath,'utf8')):null;
const cli=binding?.path
 ? resolve(binding.path,'packages/engine/dist/bin/forgeax.mjs')
 : resolve(root,'node_modules/@forgeax/engine/dist/bin/forgeax.mjs');
if(!existsSync(cli))throw Error('Selected Engine CLI is not built: '+cli);
const child=spawn(process.execPath,[cli,...args],{cwd:root,env:environment,stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
