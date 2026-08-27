/**
 * Offline procedural instrumental loop → assets/music/theme.wav
 * No API needed. Run: node scripts/sfx/bake-theme-wav.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'assets', 'music', 'theme.wav');

const SR = 22050;
const SECONDS = 36;
const N = SR * SECONDS;

function envAttack(i, a, len) {
  if (i < a) return i / a;
  const rel = len - i;
  if (rel < a * 4) return Math.max(0, rel / (a * 4));
  return 1;
}

function tone(t, freq, type) {
  const ph = t * freq * Math.PI * 2;
  if (type === 'sine') return Math.sin(ph);
  if (type === 'tri') {
    const x = (t * freq) % 1;
    return x < 0.5 ? x * 4 - 1 : 3 - x * 4;
  }
  // soft square
  return Math.sin(ph) > 0 ? 0.55 : -0.55;
}

const root = 46; // Bb1-ish MIDI
const scale = [0, 3, 5, 7, 10, 12, 15, 17]; // minor-ish
function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

const data = new Float32Array(N);
const bpm = 88;
const beat = 60 / bpm;

for (let i = 0; i < N; i++) {
  const t = i / SR;
  const bar = Math.floor(t / (beat * 4));
  let s = 0;

  // Sub pulse
  const pulse = Math.sin(t * Math.PI * 2 * (midiToHz(root) / 2));
  const pulseEnv = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * (bpm / 60));
  s += pulse * 0.12 * pulseEnv;

  // Pad chord (root + minor third + fifth)
  const chord = [0, 3, 7, 10].map((d) => midiToHz(root + 12 + d));
  for (let c = 0; c < chord.length; c++) {
    s += tone(t, chord[c], 'sine') * 0.045;
    s += tone(t, chord[c] * 0.5, 'tri') * 0.02;
  }

  // Sparse arp
  const step = Math.floor(t / (beat / 2));
  const note = scale[step % scale.length];
  const freq = midiToHz(root + 24 + note + (bar % 2) * 5);
  const local = t % (beat / 2);
  const aEnv = Math.exp(-local * 9) * envAttack(Math.floor(local * SR), 40, Math.floor((beat / 2) * SR));
  s += tone(t, freq, 'tri') * 0.07 * aEnv;
  s += tone(t, freq * 2, 'sine') * 0.025 * aEnv;

  // Soft noise dust
  s += (Math.random() * 2 - 1) * 0.008;

  // Gentle lowpass-ish by mixing
  data[i] = Math.max(-1, Math.min(1, s * 0.85));
}

// Crossfade ends for loop (1.2s)
const fade = Math.floor(SR * 1.2);
for (let i = 0; i < fade; i++) {
  const w = i / fade;
  data[i] = data[i] * w + data[N - fade + i] * (1 - w);
}
for (let i = 0; i < fade; i++) {
  data[N - fade + i] = data[i];
}

// Write 16-bit mono WAV
const bytesPerSample = 2;
const dataSize = N * bytesPerSample;
const buf = Buffer.alloc(44 + dataSize);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * bytesPerSample, 28);
buf.writeUInt16LE(bytesPerSample, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataSize, 40);
for (let i = 0; i < N; i++) {
  const v = Math.max(-1, Math.min(1, data[i]));
  buf.writeInt16LE((v * 32767) | 0, 44 + i * 2);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);
console.log('wrote', OUT, (buf.length / 1024).toFixed(1) + 'KB');
