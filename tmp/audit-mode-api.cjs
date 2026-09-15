// Mode rules (modes/small-battle/js) survived the SPA merge; the fork engine they
// were written against did not. Anything they reach for that root js/ never defines
// is a silent no-op (or a TypeError where the call site forgot its guard).
//
// Three passes:
//   1. VF.<Obj> namespaces the mode layer uses but nobody defines
//   2. VF.<Obj>.<member> / game.<handle>.<member> calls with no root definition
//   3. property reads (no call parens) on the same objects
const fs = require('fs');
const path = require('path');

const modeDir = 'modes/small-battle/js';
const read = (f) => fs.readFileSync(f, 'utf8');
const jsIn = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f));

const modeFiles = jsIn(modeDir);
const rootFiles = jsIn('js');
const rootSrc = rootFiles.map(read).join('\n');
const modeSrc = modeFiles.map(read).join('\n');
const allSrc = rootSrc + '\n' + modeSrc;

function definedIn(src, name) {
  return [
    new RegExp('prototype\\.' + name + '\\s*='),
    new RegExp('\\b' + name + '\\s*[:=]'),
    new RegExp('function\\s+' + name + '\\b'),
    new RegExp('\\b' + name + '\\s*\\('),
  ].some((re) => re.test(src));
}

// ---- pass 1: namespaces
const namespaces = new Set();
for (const m of modeSrc.matchAll(/VF\.(\w+)\b/g)) namespaces.add(m[1]);
const deadNs = [...namespaces].filter(
  (ns) => !new RegExp('VF\\.' + ns + '\\s*=|' + ns + '\\s*:').test(allSrc),
);

// ---- pass 2 + 3: members
const calls = new Map();
const reads = new Map();
const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);

for (const m of modeSrc.matchAll(/VF\.(\w+)\.(\w+)\s*(\()?/g)) {
  bump(m[3] ? calls : reads, 'VF.' + m[1] + '.' + m[2]);
}
for (const m of modeSrc.matchAll(/\bgame\.(ai|player|weapons|building|world|pvp)\.(\w+)\s*(\()?/g)) {
  bump(m[3] ? calls : reads, 'game.' + m[1] + '.' + m[2]);
}
for (const m of modeSrc.matchAll(/\bVF\.game\.(\w+)\s*(\()?/g)) {
  bump(m[2] ? calls : reads, 'VF.game.' + m[1]);
}

function report(title, map) {
  const missing = [];
  for (const [k, n] of map) {
    const member = k.split('.').pop();
    if (definedIn(rootSrc, member)) continue;
    missing.push([k, n, definedIn(modeSrc, member) ? 'mode layer' : 'NOWHERE']);
  }
  missing.sort((a, b) => b[1] - a[1]);
  console.log('\n' + title + ' (' + missing.length + '/' + map.size + ')');
  for (const [k, n, where] of missing) {
    const flag = where === 'NOWHERE' ? '  <-- dead' : '';
    console.log('  ' + k.padEnd(34) + ' x' + String(n).padEnd(4) + where + flag);
  }
}

console.log('VF namespaces used by mode layer but defined nowhere:');
console.log(deadNs.length ? '  ' + deadNs.join(', ') : '  (none)');
report('Calls with no root definition', calls);
report('Property reads with no root definition', reads);
