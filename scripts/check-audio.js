'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sfxRoot = path.join(root, 'assets', 'sfx');
const manifestPath = path.join(sfxRoot, 'manifest.json');
const licensesPath = path.join(sfxRoot, '_manifest', 'licenses.csv');
const requiredWeapons = [
  'ak74',
  'acr',
  'scarh',
  'm4a1',
  'hk419',
  'mp7',
  'p90',
  'mp5',
  'm249',
  'mk14ebr',
  'm200',
  'usp',
];

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

function csvLine(line) {
  const fields = [];
  const pattern = /"((?:[^"]|"")*)"(?:,|$)/g;
  let match;
  while ((match = pattern.exec(line))) fields.push(match[1].replace(/""/g, '"'));
  return fields;
}

function resolveSound(manifest, id) {
  let entry = manifest.sounds[id];
  let guard = 0;
  while (entry && entry.alias && guard++ < 8) entry = manifest.sounds[entry.alias];
  return entry;
}

function listFiles(dir, output) {
  output = output || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, output);
    else output.push(full);
  });
  return output;
}

function inspectWav(file) {
  const bytes = fs.readFileSync(file);
  ok(bytes.length >= 46, 'WAV is too short: ' + file);
  ok(bytes.toString('ascii', 0, 4) === 'RIFF', 'missing RIFF header: ' + file);
  ok(bytes.toString('ascii', 8, 12) === 'WAVE', 'missing WAVE header: ' + file);
  const format = bytes.readUInt16LE(20);
  const channels = bytes.readUInt16LE(22);
  const rate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  ok(format === 1 && channels === 1 && rate === 44100 && bits === 16, 'wrong WAV format: ' + file);
  let peak = 0;
  for (let offset = 44; offset + 1 < bytes.length; offset += 2) {
    peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset) / 32768));
  }
  ok(peak > 0.01, 'silent WAV: ' + file);
  ok(peak <= 0.825, 'peak exceeds generator limit: ' + file + ' (' + peak + ')');
  return peak;
}

function run() {
  ok(fs.existsSync(manifestPath), 'assets/sfx/manifest.json is missing');
  ok(fs.existsSync(licensesPath), 'assets/sfx/_manifest/licenses.csv is missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  ok(manifest.format === 'wav-pcm16-mono-44100', 'manifest format is incorrect');
  ok(manifest.fallbackPolicy === 'procedural', 'procedural fallback policy is missing');
  ok(manifest.concurrency.global === 32, 'global voice cap must be 32');
  ok(manifest.buses.weapons != null && manifest.buses.vehicles != null, 'audio buses are incomplete');

  const published = new Set();
  Object.keys(manifest.sounds).forEach((id) => {
    const entry = resolveSound(manifest, id);
    ok(entry, 'broken sound alias: ' + id);
    (entry.files || []).concat(entry.distantFiles || []).forEach((file) => published.add(file));
  });
  ok(published.size >= 90, 'too few published SFX files: ' + published.size);

  const rows = fs
    .readFileSync(licensesPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(csvLine);
  ok(rows[0][1] === 'path' && rows[0][2] === 'source_type', 'license CSV header is invalid');
  const licensed = new Set(rows.slice(1).map((row) => row[1].replace(/\\/g, '/')));
  let peakMax = 0;
  let publishedBytes = 0;
  published.forEach((file) => {
    const disk = path.join(sfxRoot, file);
    ok(fs.existsSync(disk), 'manifest file missing from disk: ' + file);
    ok(licensed.has('assets/sfx/' + file), 'license row missing: ' + file);
    publishedBytes += fs.statSync(disk).size;
    peakMax = Math.max(peakMax, inspectWav(disk));
  });
  rows.slice(1).forEach((row) => {
    ok(row[2] === 'procedural', 'non-procedural source is not approved: ' + row[1]);
    ok(row[3] === 'Project-original', 'unexpected license: ' + row[1]);
    ok(row[6] === 'scripts/audio-gen/generate-sfx.js', 'generator record missing: ' + row[1]);
  });
  listFiles(sfxRoot)
    .filter((file) => /\.wav$/i.test(file))
    .forEach((file) => {
      const relative = path.relative(root, file).replace(/\\/g, '/');
      ok(licensed.has(relative), 'WAV is missing from license ledger: ' + relative);
    });

  requiredWeapons.forEach((id) => {
    ok(manifest.weaponProfiles[id], 'weapon profile mapping missing: ' + id);
    ['fire', 'empty', 'reload_start', 'reload_mag', 'reload_rack'].forEach((action) => {
      ok(resolveSound(manifest, 'weapon.' + id + '.' + action), 'weapon sound missing: ' + id + '.' + action);
    });
  });

  [
    'character.footstep.walk',
    'character.footstep.run',
    'character.footstep.crouch',
    'character.jump',
    'character.land.soft',
    'character.land.hard',
    'character.hurt',
    'character.death',
    'throwable.frag.pin',
    'throwable.frag.throw',
    'throwable.frag.bounce',
    'throwable.frag.detonate',
    'throwable.flash.detonate',
    'throwable.flash.ring',
    'throwable.smoke.ignite',
    'throwable.smoke.loop',
    'vehicle.jeep.engine',
    'vehicle.jeep.movement',
    'vehicle.ifv.engine',
    'vehicle.ifv.movement',
    'vehicle.tank.engine',
    'vehicle.tank.movement',
    'vehicle.weapon.tank_cannon',
    'vehicle.explosion.cannon',
    'vehicle.explosion.he',
  ].forEach((id) => ok(resolveSound(manifest, id), 'critical sound missing: ' + id));
  ok(resolveSound(manifest, 'throwable.frag.detonate').gain >= 1.3, 'frag detonate gain is still too quiet');
  ok(resolveSound(manifest, 'vehicle.weapon.tank_hmg').gain >= 1.1, 'tank HMG gain is still too quiet');
  ok(manifest.buses.explosives >= 1.05 && manifest.buses.vehicles >= 0.9, 'explosion/vehicle buses are too quiet');

  const sources = {
    audio: fs.readFileSync(path.join(root, 'js', 'audio.js'), 'utf8'),
    player: fs.readFileSync(path.join(root, 'js', 'player.js'), 'utf8'),
    weapons: fs.readFileSync(path.join(root, 'js', 'weapons.js'), 'utf8'),
    throwables: fs.readFileSync(path.join(root, 'js', 'throwables.js'), 'utf8'),
    vehicles: fs.readFileSync(path.join(root, 'js', 'vehicles.js'), 'utf8'),
    effects: fs.readFileSync(path.join(root, 'js', 'vehicle-effects.js'), 'utf8'),
    gadgets: fs.readFileSync(path.join(root, 'js', 'gadgets.js'), 'utf8'),
    main: fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8'),
    pvp: fs.readFileSync(path.join(root, 'js', 'pvp.js'), 'utf8'),
    index: fs.readFileSync(path.join(root, 'index.html'), 'utf8'),
  };
  ['position', 'maxDistance', 'priority', 'delay', 'variant'].forEach((option) => {
    ok(sources.audio.indexOf(option) >= 0, 'router option missing: ' + option);
  });
  ok(
    sources.audio.indexOf('decodeAudioData') >= 0 &&
      sources.audio.indexOf('_buffers') >= 0 &&
      sources.audio.indexOf('updateListener') >= 0 &&
      sources.audio.indexOf('MAX_ACTIVE = 32') >= 0 &&
      sources.audio.indexOf("assets/music/theme.wav") >= 0,
    'audio router/cache/listener/theme fallback is incomplete'
  );
  ok(
    sources.player.indexOf("'character.hurt'") >= 0 &&
      sources.player.indexOf("'character.death'") >= 0 &&
      sources.weapons.indexOf("'.fire'") >= 0,
    'player or local weapon events are not routed'
  );
  ok(
    sources.throwables.indexOf("'throwable.' + state.equipped + '.pin'") >= 0 &&
      sources.throwables.indexOf("'throwable.frag.detonate'") >= 0 &&
      sources.throwables.indexOf("'throwable.smoke.loop'") >= 0 &&
      sources.throwables.indexOf('stopLoop(z.audioKey') >= 0,
    'throwable sound lifecycle is incomplete'
  );
  ok(
    sources.main.indexOf('def.soundId') >= 0 &&
      sources.pvp.indexOf('weaponFireSeq') >= 0 &&
      sources.index.indexOf('js/audio.js?v=sfx5') >= 0 &&
      sources.audio.indexOf('setMusicAllowed') >= 0 &&
      sources.main.indexOf('setMusicAllowed(false)') >= 0,
    'vehicle/remote/cache-version audio wiring is incomplete'
  );
  ok(
    sources.audio.indexOf('_isOccupantSource') >= 0 &&
      sources.audio.indexOf('vehicleCameraMode') >= 0 &&
      sources.audio.indexOf('playExplosionAt') >= 0 &&
      sources.effects.indexOf("playExplosionAt(point, 'cannon'") >= 0 &&
      sources.main.indexOf('playProjectileBlastAudio') >= 0 &&
      sources.throwables.indexOf('gain: 1.6') >= 0 &&
      sources.gadgets.indexOf("playExplosionAt(origin, 'he'") >= 0,
    'third-person vehicle mix or missing blast audio is incomplete'
  );

  return {
    ok: true,
    manifestSoundIds: Object.keys(manifest.sounds).length,
    publishedFiles: published.size,
    licenseRows: rows.length - 1,
    peakMax: Number(peakMax.toFixed(4)),
    publishedMiB: Number((publishedBytes / 1024 / 1024).toFixed(2)),
    weapons: requiredWeapons.length,
  };
}

try {
  console.log(JSON.stringify(run(), null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
}
