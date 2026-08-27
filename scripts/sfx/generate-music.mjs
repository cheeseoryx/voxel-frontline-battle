/**
 * MiniMax instrumental music → assets/music/theme.mp3
 * Usage: node scripts/sfx/generate-music.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'assets', 'music');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

function hexToBuffer(hex) {
  const clean = String(hex || '').replace(/\s+/g, '');
  if (!clean || clean.length % 2 !== 0) throw new Error('Invalid hex audio');
  return Buffer.from(clean, 'hex');
}

async function main() {
  loadEnvFile();
  const apiKey = process.env.MINIMAX_API_KEY;
  const apiBase = (process.env.MINIMAX_API_BASE || 'https://api.minimaxi.com/v1').replace(
    /\/$/,
    ''
  );
  if (!apiKey) {
    console.error('Missing MINIMAX_API_KEY');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'theme.mp3');
  if (fs.existsSync(out) && !process.argv.includes('--force')) {
    console.log('skip theme.mp3 (exists). Use --force to regenerate.');
    return;
  }

  const prompt =
    'Dark cinematic tactical FPS menu theme, instrumental only, no vocals, ' +
    'low pulse bass, sparse military percussion, cold synth pads, tense atmosphere, ' +
    'voxel war frontline, loop-friendly, 90 BPM, moody dusk ruins, not cheerful';

  const payload = {
    model: process.env.MINIMAX_MUSIC_MODEL || 'music-3.0-free',
    prompt,
    is_instrumental: true,
    stream: false,
    output_format: 'hex',
    audio_setting: {
      sample_rate: 44100,
      bitrate: 128000,
      format: 'mp3',
    },
  };

  console.log('MiniMax music_generation →', out);
  console.log('model:', payload.model);

  const res = await fetch(`${apiBase}/music_generation`, {
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
    throw new Error(`Non-JSON (${res.status}): ${raw.slice(0, 300)}`);
  }
  const code = data?.base_resp?.status_code;
  if (code !== 0 && code !== undefined) {
    throw new Error(`API ${code}: ${data.base_resp?.status_msg} | ${raw.slice(0, 400)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 400)}`);

  const audioHex = data?.data?.audio;
  if (!audioHex) throw new Error(`No audio: ${raw.slice(0, 400)}`);
  const buf = hexToBuffer(audioHex);
  fs.writeFileSync(out, buf);
  console.log('ok', buf.length, 'bytes', 'duration_ms=', data?.extra_info?.music_duration);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
