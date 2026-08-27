/**
 * MiniMax T2A → assets/voice/*.mp3
 * Usage: node scripts/sfx/generate-voice.mjs
 * Requires MINIMAX_API_KEY in .env or environment.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'assets', 'voice');
const MANIFEST = path.join(__dirname, 'voice-manifest.json');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function hexToBuffer(hex) {
  const clean = String(hex || '').replace(/\s+/g, '');
  if (!clean || clean.length % 2 !== 0) {
    throw new Error('Invalid hex audio payload');
  }
  return Buffer.from(clean, 'hex');
}

async function synthesize(apiBase, apiKey, cfg, line) {
  const voiceSetting = {
    voice_id: cfg.voice_id || 'male-qn-qingse',
    speed: cfg.speed != null ? cfg.speed : 1.05,
    vol: cfg.vol != null ? cfg.vol : 1,
    pitch: cfg.pitch != null ? cfg.pitch : 0,
  };
  // emotion is model/voice-dependent; only send when explicitly set on a line
  if (line.emotion) voiceSetting.emotion = line.emotion;

  const payload = {
    model: cfg.model || 'speech-2.8-hd',
    text: line.text,
    stream: false,
    language_boost: 'Chinese',
    output_format: 'hex',
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  };

  const url = `${apiBase.replace(/\/$/, '')}/t2a_v2`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${raw.slice(0, 240)}`);
  }

  const code = data?.base_resp?.status_code;
  if (code !== 0 && code !== undefined) {
    throw new Error(
      `API ${code}: ${data.base_resp?.status_msg || 'unknown'} | ${raw.slice(0, 300)}`
    );
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
  }

  const audioHex = data?.data?.audio;
  if (!audioHex) {
    throw new Error(`No audio field: ${raw.slice(0, 400)}`);
  }
  return hexToBuffer(audioHex);
}

async function main() {
  loadEnvFile();
  const apiKey = process.env.MINIMAX_API_KEY;
  const apiBase = process.env.MINIMAX_API_BASE || 'https://api.minimaxi.com/v1';
  if (!apiKey) {
    console.error('Missing MINIMAX_API_KEY (.env or env)');
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const lines = cfg.lines.filter((l) => !only.length || only.includes(l.id));

  console.log(`MiniMax T2A → ${OUT_DIR}`);
  console.log(`Base: ${apiBase}  lines: ${lines.length}`);

  for (const line of lines) {
    const out = path.join(OUT_DIR, `${line.id}.mp3`);
    if (fs.existsSync(out) && !process.argv.includes('--force')) {
      console.log(`skip ${line.id} (exists)`);
      continue;
    }
    process.stdout.write(`gen  ${line.id} "${line.text}" ... `);
    try {
      const buf = await synthesize(apiBase, apiKey, cfg, line);
      fs.writeFileSync(out, buf);
      console.log(`ok (${buf.length} bytes)`);
    } catch (err) {
      console.log('FAIL');
      console.error(`  ${err.message || err}`);
      process.exitCode = 1;
    }
    // mild rate limit
    await new Promise((r) => setTimeout(r, 400));
  }

  // Write runtime index (only existing mp3s) so the game does not 404-spam
  const files = cfg.lines
    .map((l) => l.id)
    .filter((id) => fs.existsSync(path.join(OUT_DIR, `${id}.mp3`)));
  fs.writeFileSync(
    path.join(OUT_DIR, 'index.json'),
    JSON.stringify({ files }, null, 2) + '\n'
  );
  console.log(`index.json → ${files.length} clip(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
