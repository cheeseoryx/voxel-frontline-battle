const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..'),out=path.resolve(__dirname,'../assets/original');const sources=[];
for(const mode of ['large','small']){
 const relative=(mode==='large'?'js/':'modes/small-battle/js/')+'economy.js';const s=fs.readFileSync(path.join(root,relative),'utf8');
 // Keep the original business rules intact. Only the execution boundary changes:
 // injected storage and optional UI host replace process-wide browser globals.
 const start=s.indexOf("  'use strict';"),end=s.lastIndexOf('})(typeof window');if(start<0||end<0)throw Error('Original economy wrapper changed');
 const body=s.slice(start,end).replace("  'use strict';",'').replace("const el = document.getElementById('lobby-coin-num');","const el = document?.getElementById('lobby-coin-num');");fs.writeFileSync(path.join(out,mode+'-economy.ts'),'// @ts-nocheck\n// Generated from '+relative+'; changes belong in the importer/original rules.\nexport function createEconomy(global, localStorage, document=undefined) {\n'+body+'\nreturn global.VF.Economy;\n}\n');sources.push({path:relative,sha256:crypto.createHash('sha256').update(s).digest('hex')});
}
fs.writeFileSync(path.join(__dirname,'../docs/migration/economy-provenance.json'),JSON.stringify({sources},null,2));
