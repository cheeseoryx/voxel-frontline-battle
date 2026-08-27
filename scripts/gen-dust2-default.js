const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const kit = JSON.parse(fs.readFileSync(path.join(root, 'assets/maps/dust2-kit.json'), 'utf8'));
const outDir = path.join(root, 'js/maps');
fs.mkdirSync(outDir, { recursive: true });
const body =
  '/** Default map kit (sync). Source: assets/maps/dust2-kit.json */\n' +
  '(function (g) {\n' +
  "  'use strict';\n" +
  '  g.VF = g.VF || {};\n' +
  '  g.VF.DEFAULT_MAP_KIT = ' +
  JSON.stringify(kit) +
  ';\n' +
  '})(typeof window !== "undefined" ? window : globalThis);\n';
fs.writeFileSync(path.join(outDir, 'dust2-default.js'), body);
console.log('wrote js/maps/dust2-default.js', body.length, 'bytes');
