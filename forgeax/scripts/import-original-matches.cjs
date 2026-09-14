const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..'),out=path.resolve(__dirname,'../assets/original'),records=[];
for(const [file,name] of [['tdm-match','TdmMatch'],['ffa-match','FfaMatch'],['gg-match','GgMatch'],['sd-match','SdMatch'],['sd-bomb','SdBomb'],['sd-stats','SdStats'],['tdm-spawn','TdmSpawn'],['ffa-spawn','FfaSpawn']]){
 const source='modes/small-battle/js/'+file+'.js',bytes=fs.readFileSync(path.join(root,source)),text=bytes.toString('utf8');
 const start=text.indexOf('(function (global) {'),end=text.lastIndexOf("})(typeof window !== 'undefined' ? window : globalThis);");
 if(start<0||end<0)throw Error('Unrecognized original module '+file);
 const body=text.slice(start+'(function (global) {'.length,end).replace(/['"]use strict['"];?/, '');
 const result='// @ts-nocheck\n// Generated original rules; isolated session environment, driven by Engine World.Update.\n'+text.slice(0,start)+'export function install'+name+'(global, setTimeout = global.setTimeout) {'+body+'\nreturn global.VF.'+name+';\n}\n';
 fs.writeFileSync(path.join(out,file+'.ts'),result);records.push({path:source,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),export:'install'+name,bodyUnchangedExceptModuleStrictDirective:true});
}
fs.writeFileSync(path.join(__dirname,'../docs/migration/match-provenance.json'),JSON.stringify(records,null,2));console.log('Imported '+records.length+' original match modules.');
