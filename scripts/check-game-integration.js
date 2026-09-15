'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const small = path.join(root, 'modes/small-battle');
function files(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : [path.join(dir,e.name)]);
}
function verifyRefs(file, regex) {
  const text = fs.readFileSync(file,'utf8');
  for(const match of text.matchAll(regex)) {
    const value=match[1];
    if (/^(https?:|data:|#)/.test(value)) continue;
    assert(fs.existsSync(path.resolve(path.dirname(file),value.split(/[?#]/)[0])), file+': missing '+value);
  }
}
let scripts = 0;
for(const file of [path.join(root,'js/game-entry.js'), path.join(root,'js/frontline-ui.js'), path.join(root,'js/menu-soldier.js'), path.join(root,'js/deployment-presentation.js'), path.join(root,'js/small-arenas.js'), path.join(root,'js/pvp.js'), path.join(root,'js/hub.js'), ...files(path.join(small,'js'))]) {
  if(file.endsWith('.js')) { new vm.Script(fs.readFileSync(file,'utf8'),{filename:file}); scripts++; }
}
verifyRefs(path.join(root,'index.html'), /<(?:script|link|img)\b[^>]*?(?:src|href)="([^"]+)"/g);
verifyRefs(path.join(root,'styles/preview-fidelity.css'),/url\(['"]?([^'")]+)['"]?\)/g);
const manifest=JSON.parse(fs.readFileSync(path.join(small,'integration.json')));
manifest.sharedAssets.forEach(f=>assert(fs.existsSync(path.join(root,'assets',f))));
manifest.modeAssets.forEach(f=>assert(fs.existsSync(path.join(small,'assets',f))));
const entry=fs.readFileSync(path.join(root,'js/game-entry.js'),'utf8');
assert(!/location\.(assign|replace)\s*\(/.test(entry),'game-entry must stay on one document');
assert(!/location\.href\s*=/.test(entry),'game-entry must stay on one document');
function navigation(base, search='') {
  const window={location:{href:new URL(search||'./',base).href,search,pathname:new URL(search||'./',base).pathname,hash:''},dispatchEvent(){},addEventListener(){},history:{replaceState(){}}};
  const document={body:{dataset:{gameRuntime:'large'},classList:{add(){},toggle(){}}},currentScript:{src:new URL('js/game-entry.js',base).href},addEventListener(){},getElementById(){return {classList:{add(){},remove(){}},remove(){}};}};
  vm.runInNewContext(entry,{window,document,URL,URLSearchParams,Event:function(){}});
  return window;
}
for(const base of ['http://localhost:8765/','https://example.test/game/','file:///F:/voxel-frontline-battle/']) {
  const n=navigation(base,'?unknown=1');
  n.VFEntry.openSmallBattle('tdm','ABCD12');
  assert.equal(n.VFEntry.selection.mode,'tdm');
  assert.equal(n.VFEntry.selection.room,'ABCD12');
  n.VFEntry.goHome();
  assert.equal(n.VFEntry.selection.screen,null);
}
const smallCode=files(path.join(small,'js')).filter(f=>f.endsWith('.js')).map(f=>fs.readFileSync(f,'utf8')).join('\n');
assert(!/['"]vf_(?!small_|audio_muted\b)/.test(smallCode),'Small battle must not write large-war save or LAN bus keys');
const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
assert(index.includes('<span>进入大厅</span>'));
assert(!index.includes('peerjs'));
assert(!index.includes('kubee-bridge'));
assert(!index.includes('small-quickmatch'));
assert(!index.includes('modes/small-battle/js/pvp.js'));
assert(!index.includes('modes/small-battle/js/main.js'));
assert(!index.includes('modes/small-battle/js/voxel-world.js'));
assert(!fs.existsSync(path.join(small,'index.html')));
assert(!fs.existsSync(path.join(small,'js/pvp.js')));
assert(!manifest.peerPrefix);
const pvp=fs.readFileSync(path.join(root,'js/pvp.js'),'utf8');
assert(!/VF_KUBEE|new Peer\(|PEER_PREFIX/.test(pvp),'live pvp must not keep Kubee or PeerJS rooms');
assert(!/VF_KUBEE|PeerJS/.test(fs.readFileSync(path.join(root,'js/hub.js'),'utf8')));
assert.equal((index.match(/class="operation-card"/g)||[]).length,6);
assert(index.includes('class="solo-banner"') && index.includes('id="server-browser"'));
assert(index.includes('id="tdm-result"') && index.includes('js/small-arenas.js'));
console.log(JSON.stringify({ok:true,checkedScripts:scripts,sharedAssets:manifest.sharedAssets.length,modeAssets:manifest.modeAssets.length,navigation:'in-page screens only',isolatedSavesAndRooms:true},null,2));

for (const mode of ['tdm','demo','ffa','gungame','core']) {
 const n = navigation('https://example.test/game/');
 n.VFEntry.openSmallBattle(mode,'ABCD12');
 assert.equal(n.VFEntry.selection.mode,mode);
}
const unknown = navigation('https://example.test/game/','?mode=untrusted&screen=play&room=bad!');
assert.equal(unknown.VFEntry.selection.mode,null);
assert.equal(unknown.VFEntry.selection.screen,null);
assert.equal(unknown.VFEntry.selection.room,null);
