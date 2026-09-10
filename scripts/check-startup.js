'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const root = path.resolve(__dirname, '..');
const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:8765/');

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function request(relative) {
  const url = new URL(relative, baseUrl);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          url: url.href,
          status: response.statusCode,
          type: String(response.headers['content-type'] || '').toLowerCase(),
          body: Buffer.concat(chunks),
        });
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('request timed out: ' + url.href)));
    req.on('error', reject);
  });
}

function checkSources() {
  const index = read('index.html');
  const main = read('js/main.js');
  const kubee = read('js/kubee-bridge.js');

  ok(/<div\s+id="start-overlay"(?![^>]*\bhidden\b)[^>]*>/.test(index), 'default entry overlay must be visible');
  ok(/<div\s+id="mode-overlay"\s+class="hidden"/.test(index), 'mode overlay must start hidden');
  ok(/<div\s+id="hud"\s+class="hidden"/.test(index), 'match HUD must start hidden');
  ok(/id="startup-critical-css"/.test(index), 'critical startup style is missing');
  ok(/\.hidden\s*\{\s*display:\s*none\s*!important/.test(index), 'critical hidden rule is missing');
  ok(/#start-overlay\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/s.test(index), 'entry overlay is not fail-closed');

  ok(!/forceRefresh/.test(main), 'forceRefresh must not select a startup mode');
  ok(!/URLSearchParams|location\.(?:search|hash)/.test(main), 'main bootstrap must not infer a mode from arbitrary URL parameters');
  ok(!/localStorage|sessionStorage/.test(main), 'main bootstrap must not restore a match from browser storage');
  ok(
    /[?&]kubee=1/.test(kubee) && /global\.parent !== global/.test(kubee),
    'the explicit Kubee embed route is missing'
  );
  const soldier = read('js/soldier.js');
  ok(
    /const enemyTint = team === 'enemy'/.test(soldier) &&
      !/enemyTint = L && L\.kind \? L\.kind\(team\) === 'foe'/.test(soldier),
    'soldier uniforms must follow faction id, not relative TeamLook'
  );
  ok(
    /createPreviewSoldier\(classId, opts\)/.test(soldier) &&
      /resolveFactionTeam\(opts && opts\.team\)/.test(soldier),
    'class previews must use the assigned faction'
  );
}

async function checkServer() {
  const [rootPage, forceRefreshPage, unknownPage, style, main] = await Promise.all([
    request('/'),
    request('/?forceRefresh=startup-check'),
    request('/?unknownStartupParam=startup-check'),
    request('/style.css?startup-check'),
    request('/js/main.js?startup-check'),
  ]);

  [rootPage, forceRefreshPage, unknownPage, style, main].forEach((response) => {
    ok(response.status === 200, response.url + ' returned HTTP ' + response.status);
  });
  [rootPage, forceRefreshPage, unknownPage].forEach((response) => {
    ok(response.type.includes('text/html'), response.url + ' has invalid HTML MIME: ' + response.type);
    ok(response.body.includes(Buffer.from('id="start-overlay"')), response.url + ' does not serve the entry screen');
  });
  ok(forceRefreshPage.body.equals(rootPage.body), 'forceRefresh changed the served entry document');
  ok(unknownPage.body.equals(rootPage.body), 'an unknown query parameter changed the served entry document');
  ok(style.type.includes('text/css'), style.url + ' has invalid CSS MIME: ' + style.type);
  ok(
    /javascript|ecmascript/.test(main.type),
    main.url + ' has invalid JavaScript MIME: ' + main.type
  );

  return {
    baseUrl: baseUrl.href,
    htmlMime: rootPage.type,
    cssMime: style.type,
    jsMime: main.type,
    forceRefreshNeutral: true,
    unknownQueryNeutral: true,
  };
}

(async function run() {
  try {
    checkSources();
    const server = await checkServer();
    console.log(JSON.stringify({ ok: true, defaultView: 'entry', server }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
})();
