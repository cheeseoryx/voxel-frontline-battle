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
for(const file of [path.join(root,'js/game-entry.js'), path.join(root,'js/frontline-ui.js'), path.join(root,'js/menu-soldier.js'), path.join(root,'js/deployment-presentation.js'), path.join(root,'js/small-quickmatch.js'), ...files(path.join(small,'js'))]) {
  if(file.endsWith('.js')) { new vm.Script(fs.readFileSync(file,'utf8'),{filename:file}); scripts++; }
}
for(const file of [path.join(root,'index.html'),path.join(small,'index.html')]) verifyRefs(file, /<(?:script|link|img)\b[^>]*?(?:src|href)="([^"]+)"/g);
verifyRefs(path.join(small,'style.css'),/url\(['"]?([^'")]+)['"]?\)/g);
verifyRefs(path.join(root,'styles/preview-fidelity.css'),/url\(['"]?([^'")]+)['"]?\)/g);
const manifest=JSON.parse(fs.readFileSync(path.join(small,'integration.json')));
manifest.sharedAssets.forEach(f=>assert(fs.existsSync(path.join(root,'assets',f))));
manifest.modeAssets.forEach(f=>assert(fs.existsSync(path.join(small,'assets',f))));
const entry=fs.readFileSync(path.join(root,'js/game-entry.js'),'utf8');
function navigation(base, search='', embedded=false) {
  let click, destination;
  const window={location:{href:new URL(search||'./',base).href,search,assign:url=>{destination=url;}},dispatchEvent(){},addEventListener(){},history:{replaceState(){}}};
  window.parent=embedded?{}:window;
  const document={currentScript:{src:new URL('js/game-entry.js',base).href},addEventListener:(name,fn)=>{if(name==='click')click=fn;}};
  vm.runInNewContext(entry,{window,document,URL,URLSearchParams,Event:function(){}});
  return {window, click:target=>click({target:{closest:selector=>selector==='[data-game-entry]'?({getAttribute:()=>target}):null},preventDefault(){},stopPropagation(){}}),destination:()=>destination};
}
for(const base of ['http://localhost:8765/','https://example.test/game/','file:///F:/voxel-frontline-battle/']) {
  const n=navigation(base,'?unknown=1');
  n.click('small-battle');
  assert.equal(n.destination(),new URL('modes/small-battle/index.html',base).href);
  const home=navigation(base);home.click('home');
  assert.equal(home.destination(),new URL('index.html',base).href);
}
const embed=navigation('https://example.test/game/','?kubee=1&unknown=1',true);
embed.click('small-battle');
assert.equal(new URL(embed.destination()).search,'?kubee=1');
const smallCode=files(path.join(small,'js')).filter(f=>f.endsWith('.js')).map(f=>fs.readFileSync(f,'utf8')).join('\n');
assert(!/['"]vf_(?!small_|audio_muted\b)/.test(smallCode),'Small battle must not write large-war save or LAN bus keys');
assert(smallCode.includes("const PEER_PREFIX = 'vf-small-'"));
const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
assert(index.includes('<span>进入大厅</span>'));
assert(!index.includes('id="enter-small-battle-btn"'));
assert.equal((index.match(/class="operation-card"/g)||[]).length,6);
assert(index.includes('class="solo-banner"') && index.includes('id="server-browser"'));
assert(!/F:[\\/]+codbit/.test(fs.readFileSync(path.join(small,'index.html'),'utf8')));
console.log(JSON.stringify({ok:true,checkedScripts:scripts,sharedAssets:manifest.sharedAssets.length,modeAssets:manifest.modeAssets.length,navigation:'root, subdirectory, file and embed routes passed',isolatedSavesAndRooms:true},null,2));

// Explicit mode routes must carry only supported rule identifiers.
for (const mode of ['tdm','demo','ffa','gungame','core']) {
 const n = navigation('https://example.test/game/');
 n.window.VFEntry.openSmallBattle(mode,'ABCD12');
 assert.equal(n.destination(),'https://example.test/game/modes/small-battle/index.html?mode='+mode+'&room=ABCD12');
 const lobby=navigation('https://example.test/game/');lobby.window.VFEntry.goLobby();
 assert.equal(lobby.destination(),'https://example.test/game/index.html?screen=modes');
}
const unknown = navigation('https://example.test/game/','?mode=untrusted&screen=play&room=bad!');
assert.equal(unknown.window.VFEntry.selection.mode,null);
assert.equal(unknown.window.VFEntry.selection.screen,null);
assert.equal(unknown.window.VFEntry.selection.room,null);
