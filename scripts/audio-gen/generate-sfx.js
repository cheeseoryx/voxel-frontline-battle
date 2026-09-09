#!/usr/bin/env node
'use strict';

/**
 * Voxel Frontline SFX generator — physical-model / layered field-recording style.
 *
 * Intentionally avoids chiptune sources (square/saw/triangle beds, short sine
 * beeps, stacked harmonic buzzers). Gun reports use a Friedlander blast pulse,
 * filtered noise, inharmonic mechanical modes, and short IR/comb tails.
 * Loops are period-aligned and crossfaded. No third-party or commercial samples.
 *
 * Infantry fire reports are derived from the tank gunner HMG master
 * (`vehicle.weapon.tank_hmg` / makeTankHmgReport). Use
 * `--only=infantry-fire` to rewrite those WAVs without touching footsteps,
 * throwables, vehicle engines, or the tank cannon.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'assets', 'sfx');
const RATE = 44100;
const PEAK = 0.82;
const GENERATED_AT = new Date().toISOString();
const created = [];
const ONLY_INFANTRY_FIRE = process.argv.indexOf('--only=infantry-fire') >= 0;

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function random(seed) {
  let value = seed >>> 0 || 1;
  return function () {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function buffer(seconds) {
  return new Float32Array(Math.max(1, Math.ceil(seconds * RATE)));
}

function mix(out, src, gain, startSec) {
  if (!src || !src.length) return;
  const i0 = Math.max(0, Math.round((startSec || 0) * RATE));
  const g = gain == null ? 1 : gain;
  const n = Math.min(src.length, out.length - i0);
  for (let i = 0; i < n; i++) out[i0 + i] += src[i] * g;
}

function mulEnv(buf, attack, decay) {
  const aN = Math.max(1, Math.floor(Math.max(0.00015, attack) * RATE));
  const tau = Math.max(0.0008, decay);
  for (let i = 0; i < buf.length; i++) {
    const att = i < aN ? i / aN : 1;
    buf[i] *= att * Math.exp(-i / RATE / tau);
  }
  return buf;
}

function noiseBuffer(n, seed, color) {
  const rng = random(seed);
  const out = new Float32Array(n);
  let brown = 0;
  const pk = { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0 };
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    if (color === 'white') {
      out[i] = w;
    } else if (color === 'brown') {
      brown = (brown + w * 0.018) * 0.997;
      if (brown > 1) brown = 1;
      else if (brown < -1) brown = -1;
      out[i] = brown * 3.2;
    } else {
      pk.b0 = 0.99886 * pk.b0 + w * 0.0555179;
      pk.b1 = 0.99332 * pk.b1 + w * 0.0750759;
      pk.b2 = 0.969 * pk.b2 + w * 0.153852;
      pk.b3 = 0.8665 * pk.b3 + w * 0.3104856;
      pk.b4 = 0.55 * pk.b4 + w * 0.5329522;
      pk.b5 = -0.7616 * pk.b5 - w * 0.016898;
      out[i] = (pk.b0 + pk.b1 + pk.b2 + pk.b3 + pk.b4 + pk.b5 + pk.b6 + w * 0.5362) * 0.11;
      pk.b6 = w * 0.115926;
    }
  }
  return out;
}

function biquad(type, freq, Q) {
  const f = Math.max(18, Math.min(RATE * 0.45, freq || 1000));
  const q = Math.max(0.08, Q || 0.707);
  const w0 = (2 * Math.PI * f) / RATE;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === 'hp') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === 'bp') {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquad(src, coeff) {
  const out = new Float32Array(src.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const b0 = coeff.b0;
  const b1 = coeff.b1;
  const b2 = coeff.b2;
  const a1 = coeff.a1;
  const a2 = coeff.a2;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

function bandlimit(src, hp, lp) {
  let x = src;
  if (hp && hp > 12) {
    const c = biquad('hp', hp, 0.72);
    x = applyBiquad(applyBiquad(x, c), c);
  }
  if (lp && lp < 19000) {
    const c = biquad('lp', lp, 0.72);
    x = applyBiquad(applyBiquad(x, c), c);
  }
  return x;
}

function resample(src, ratio) {
  if (!src || !src.length) return src;
  const r = Math.max(0.72, Math.min(1.28, ratio || 1));
  if (Math.abs(r - 1) < 0.0008) return src;
  const n = Math.max(1, Math.round(src.length / r));
  const out = new Float32Array(n);
  const last = src.length - 1;
  for (let i = 0; i < n; i++) {
    const x = i * r;
    const j = Math.floor(x);
    const f = x - j;
    const a = j <= last ? src[j] : 0;
    const b = j + 1 <= last ? src[j + 1] : 0;
    out[i] = a + (b - a) * f;
  }
  return out;
}

function friedlander(n, T, gain) {
  const out = new Float32Array(n);
  const t0 = Math.max(0.0012, T);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const u = t / t0;
    out[i] = (1 - u) * Math.exp(-u) * gain;
  }
  return bandlimit(out, 8, Math.max(90, 1 / t0));
}

function modal(n, freqs, decay, gain, seed) {
  const rng = random(seed);
  const out = new Float32Array(n);
  for (let m = 0; m < freqs.length; m++) {
    const f = freqs[m];
    const tau = Array.isArray(decay) ? decay[m] : decay;
    const g = gain * (0.72 + rng() * 0.5) / freqs.length;
    let ph = rng() * Math.PI * 2;
    const inc = (Math.PI * 2 * f) / RATE;
    const d = Math.max(0.003, tau);
    for (let i = 0; i < n; i++) {
      ph += inc;
      out[i] += Math.sin(ph) * Math.exp(-i / RATE / d) * g;
    }
  }
  return out;
}

function roomIR(seconds, seed, lp, decay) {
  const n = Math.max(32, Math.floor(seconds * RATE));
  const ir = mulEnv(noiseBuffer(n, seed, 'white'), 0.0004, decay || 0.04);
  const early = [0.006, 0.011, 0.019, 0.029, 0.043];
  const rng = random(seed + 9);
  for (let e = 0; e < early.length; e++) {
    const i = Math.floor(early[e] * RATE);
    if (i < n) ir[i] += (rng() * 2 - 1) * (0.45 - e * 0.06);
  }
  return bandlimit(ir, 40, lp || 5200);
}

function convolve(out, dry, ir, gain, startSec) {
  const i0 = Math.max(0, Math.round((startSec || 0) * RATE));
  const g = gain == null ? 1 : gain;
  const n = Math.min(dry.length, out.length - i0);
  const m = ir.length;
  for (let i = 0; i < n; i++) {
    const x = dry[i];
    if (x === 0) continue;
    const lim = Math.min(m, out.length - (i0 + i));
    const s = x * g;
    for (let j = 0; j < lim; j++) out[i0 + i + j] += s * ir[j];
  }
}

function comb(out, delays, decays, lp) {
  for (let d = 0; d < delays.length; d++) {
    const off = Math.max(1, Math.floor(delays[d] * RATE));
    const dec = decays[d];
    const a = 1 - Math.exp((-Math.PI * 2 * (lp[d] || 2800)) / RATE);
    let filt = 0;
    for (let i = off; i < out.length; i++) {
      filt += a * (out[i - off] - filt);
      out[i] += filt * dec;
    }
  }
}

function whoosh(out, options) {
  const n = Math.floor(options.duration * RATE);
  const noise = noiseBuffer(n, options.seed, 'pink');
  let lp = 0;
  const i0 = Math.max(0, Math.round((options.start || 0) * RATE));
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const u = i / Math.max(1, n - 1);
    const f = options.f0 + (options.f1 - options.f0) * u;
    const a = 1 - Math.exp((-Math.PI * 2 * f) / RATE);
    lp += a * (noise[i] - lp);
    const env = Math.sin(Math.PI * Math.pow(u, options.skew || 1));
    out[i0 + i] += lp * (options.gain || 0.2) * env;
  }
}

function gravel(out, options) {
  const rng = random(options.seed);
  const count = options.count || 18;
  for (let k = 0; k < count; k++) {
    const t = (options.start || 0) + rng() * (options.duration || 0.3);
    const n = Math.max(8, Math.floor((0.0012 + rng() * 0.006) * RATE));
    const grain = mulEnv(
      bandlimit(noiseBuffer(n, options.seed + k * 17, rng() > 0.45 ? 'white' : 'pink'), options.hp || 400, options.lp || 6500),
      0.0002,
      0.004 + rng() * 0.01
    );
    mix(out, grain, (options.gain || 0.2) * (0.25 + rng() * 0.75), t);
  }
}

function dcBlock(samples) {
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = x - x1 + 0.995 * y1;
    x1 = x;
    y1 = y;
    samples[i] = y;
  }
}

function loopPrepare(samples, extra) {
  const n = samples.length - extra;
  if (n < extra * 2) return samples.subarray(0, Math.max(1, n));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = samples[i];
  for (let i = 0; i < extra; i++) {
    const w = (i / extra) * (i / extra) * (3 - 2 * (i / extra));
    out[i] = samples[n + i] * (1 - w) + samples[i] * w;
  }
  return out;
}

function peakScale(samples, ceiling) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] < 0 ? -samples[i] : samples[i];
    if (v > peak) peak = v;
  }
  if (peak > ceiling) {
    const s = ceiling / peak;
    for (let i = 0; i < samples.length; i++) samples[i] *= s;
  }
  return samples;
}

function limiter(samples) {
  const n = samples.length;
  const la = 96;
  let env = 1;
  const release = Math.exp(-1 / (0.07 * RATE));
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const end = Math.min(n, i + la);
    for (let j = i; j < end; j++) {
      const a = samples[j];
      const v = a < 0 ? -a : a;
      if (v > peak) peak = v;
    }
    const need = peak > PEAK ? PEAK / peak : 1;
    env = need < env ? need : need + (env - need) * release;
    samples[i] *= env;
  }
  let p = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i] < 0 ? -samples[i] : samples[i];
    if (v > p) p = v;
  }
  if (p > PEAK) {
    const s = PEAK / p;
    for (let i = 0; i < n; i++) samples[i] *= s;
  }
}

function master(samples, looping) {
  if (looping) {
    // Do not DC-block or time-limit loops; IIR state would click at wrap.
    return peakScale(samples, PEAK);
  }
  dcBlock(samples);
  const fadeN = Math.min(Math.floor(RATE * 0.005), Math.floor(samples.length / 4));
  for (let i = 0; i < fadeN; i++) {
    const k = i / fadeN;
    samples[i] *= k;
    samples[samples.length - 1 - i] *= k;
  }
  limiter(samples);
  return samples;
}

function wav(samples) {
  const bytes = samples.length * 2;
  const out = Buffer.alloc(44 + bytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + bytes, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    out.writeInt16LE(Math.round(c * 32767), 44 + i * 2);
  }
  return out;
}

function write(relative, samples, options) {
  options = options || {};
  const full = path.join(OUT, relative);
  ensure(path.dirname(full));
  const pcm = options.raw ? samples : master(samples, options.loop);
  fs.writeFileSync(full, wav(pcm));
  created.push({
    file: relative.replace(/\\/g, '/'),
    family: options.family || 'unspecified',
    notes: options.notes || 'physical-model layered synthesis',
  });
  return relative.replace(/\\/g, '/');
}

const TANK_HMG = {
  duration: 0.36,
  blastSec: 0.05,
  blastT: 0.004,
  blastGain: 0.7,
  blastHp: 30,
  blastLp: 140,
  noiseSec: 0.06,
  noiseHp: 300,
  noiseLp: 6500,
  noiseAttack: 0.0002,
  noiseDecay: 0.02,
  noiseGain: 0.7,
  mechSec: 0.07,
  mech: [480, 880, 1500],
  mechDecay: 0.01,
  mechGain: 0.16,
  mechOffset: 0.004,
};

function makeTankHmgReport(seed) {
  const out = buffer(TANK_HMG.duration);
  mix(
    out,
    bandlimit(
      friedlander(Math.floor(TANK_HMG.blastSec * RATE), TANK_HMG.blastT, TANK_HMG.blastGain),
      TANK_HMG.blastHp,
      TANK_HMG.blastLp
    ),
    1,
    0
  );
  mix(
    out,
    mulEnv(
      bandlimit(noiseBuffer(Math.floor(TANK_HMG.noiseSec * RATE), seed, 'white'), TANK_HMG.noiseHp, TANK_HMG.noiseLp),
      TANK_HMG.noiseAttack,
      TANK_HMG.noiseDecay
    ),
    TANK_HMG.noiseGain,
    0
  );
  mix(
    out,
    modal(Math.floor(TANK_HMG.mechSec * RATE), TANK_HMG.mech, TANK_HMG.mechDecay, TANK_HMG.mechGain, seed),
    1,
    TANK_HMG.mechOffset
  );
  return out;
}

const GUNS = {
  rifle545: {
    family: 'gun.rifle545.hmg-family',
    pitch: 0.97,
    duration: 0.38,
    blastT: 0.00415,
    blastLp: 132,
    noiseLp: 6100,
    noiseDecay: 0.022,
    lf: 1.05,
    hf: 0.94,
    mech: [455, 845, 1420],
    mechGain: 0.17,
    distantDur: 0.82,
    distantLp: 1120,
    distantDelay: 0.05,
  },
  rifle556: {
    family: 'gun.rifle556.hmg-family',
    pitch: 1.035,
    duration: 0.34,
    blastT: 0.00375,
    blastLp: 150,
    noiseLp: 7100,
    noiseDecay: 0.018,
    lf: 0.96,
    hf: 1.06,
    mech: [510, 930, 1600],
    mechGain: 0.15,
    distantDur: 0.74,
    distantLp: 1380,
    distantDelay: 0.042,
  },
  rifle762: {
    family: 'gun.rifle762.hmg-family',
    pitch: 0.945,
    duration: 0.4,
    blastT: 0.0044,
    blastLp: 124,
    noiseLp: 5600,
    noiseDecay: 0.024,
    lf: 1.1,
    hf: 0.9,
    mech: [430, 800, 1360],
    mechGain: 0.18,
    distantDur: 0.9,
    distantLp: 980,
    distantDelay: 0.055,
  },
  pdw46: {
    family: 'gun.pdw46.hmg-family',
    pitch: 1.08,
    duration: 0.3,
    blastT: 0.00345,
    blastLp: 168,
    noiseLp: 7600,
    noiseDecay: 0.016,
    lf: 0.9,
    hf: 1.1,
    mech: [540, 980, 1680],
    mechGain: 0.14,
    distantDur: 0.64,
    distantLp: 1550,
    distantDelay: 0.034,
  },
  smg9: {
    family: 'gun.smg9.hmg-family',
    pitch: 1.05,
    duration: 0.32,
    blastT: 0.00365,
    blastLp: 156,
    noiseLp: 6400,
    noiseDecay: 0.017,
    lf: 0.94,
    hf: 1.02,
    mech: [500, 910, 1540],
    mechGain: 0.18,
    distantDur: 0.68,
    distantLp: 1280,
    distantDelay: 0.038,
  },
  lmg556: {
    family: 'gun.lmg556.hmg-family',
    pitch: 1,
    duration: 0.38,
    blastT: 0.004,
    blastLp: 140,
    noiseLp: 6500,
    noiseDecay: 0.021,
    lf: 1.02,
    hf: 0.98,
    mech: [480, 880, 1500],
    mechGain: 0.17,
    distantDur: 0.84,
    distantLp: 1200,
    distantDelay: 0.048,
  },
  dmr762: {
    family: 'gun.dmr762.hmg-family',
    pitch: 0.93,
    duration: 0.42,
    blastT: 0.00455,
    blastLp: 118,
    noiseLp: 5400,
    noiseDecay: 0.026,
    lf: 1.12,
    hf: 0.88,
    mech: [410, 780, 1320],
    mechGain: 0.19,
    distantDur: 0.96,
    distantLp: 920,
    distantDelay: 0.058,
  },
  sniperheavy: {
    family: 'gun.sniperheavy.hmg-family',
    pitch: 0.9,
    duration: 0.48,
    blastT: 0.005,
    blastLp: 108,
    noiseLp: 5000,
    noiseDecay: 0.03,
    lf: 1.16,
    hf: 0.82,
    mech: [380, 720, 1240],
    mechGain: 0.2,
    distantDur: 1.12,
    distantLp: 820,
    distantDelay: 0.07,
  },
  pistol45: {
    family: 'gun.pistol45.hmg-family',
    pitch: 1.07,
    duration: 0.28,
    blastT: 0.0035,
    blastLp: 172,
    noiseLp: 7200,
    noiseDecay: 0.015,
    lf: 0.92,
    hf: 1.08,
    mech: [560, 1020, 1760],
    mechGain: 0.22,
    distantDur: 0.6,
    distantLp: 1450,
    distantDelay: 0.03,
  },
};

function makeHmgFamilyDry(p, seed, variant, close) {
  const out = buffer(p.duration);
  mix(
    out,
    bandlimit(friedlander(Math.floor(TANK_HMG.blastSec * RATE), p.blastT, TANK_HMG.blastGain * p.lf), TANK_HMG.blastHp, p.blastLp),
    1,
    0
  );
  mix(
    out,
    mulEnv(
      bandlimit(noiseBuffer(Math.floor(TANK_HMG.noiseSec * RATE), seed, 'white'), TANK_HMG.noiseHp, p.noiseLp),
      TANK_HMG.noiseAttack,
      p.noiseDecay
    ),
    TANK_HMG.noiseGain * p.hf,
    0
  );
  const mech = p.mech.map((freq) => freq * (variant === 2 ? 1.03 : 1));
  mix(out, modal(Math.floor(TANK_HMG.mechSec * RATE), mech, TANK_HMG.mechDecay, p.mechGain, seed), 1, TANK_HMG.mechOffset);
  if (close) {
    mix(
      out,
      mulEnv(bandlimit(noiseBuffer(Math.floor(0.035 * RATE), seed + 5, 'white'), 1600, 8800), 0.00015, 0.012),
      0.14 * p.hf,
      0
    );
  }
  return resample(out, p.pitch * (variant === 2 ? 1.012 : 1));
}

function makeGun(kind, variant, distant) {
  const p = GUNS[kind];
  const seed = hash('hmg-family:' + kind + ':' + variant + ':' + (distant ? 'far' : 'near'));
  const dry = makeHmgFamilyDry(p, seed, distant ? 1 : variant, !distant);
  if (!distant) return dry;
  const out = buffer(p.distantDur);
  mix(out, bandlimit(dry, 45, p.distantLp), 0.78, p.distantDelay);
  mix(
    out,
    mulEnv(bandlimit(noiseBuffer(Math.floor(0.28 * RATE), seed + 11, 'brown'), 18, p.distantLp * 0.7), 0.012, 0.16),
    0.18,
    p.distantDelay
  );
  comb(out, [0.058, 0.105, 0.19], [0.3, 0.18, 0.1], [860, 600, 380]);
  return out;
}

function makeFootstep(mode, variant) {
  const cfg = {
    walk: { dur: 0.24, heel: 0.42, grit: 16, hp: 70, lp: 2400, rubber: 0.1, weight: 0.7 },
    run: { dur: 0.2, heel: 0.62, grit: 26, hp: 55, lp: 3200, rubber: 0.16, weight: 1 },
    crouch: { dur: 0.22, heel: 0.18, grit: 10, hp: 110, lp: 1600, rubber: 0.2, weight: 0.38 },
  }[mode];
  const out = buffer(cfg.dur);
  const seed = hash('boot:' + mode + ':' + variant);
  const heel = bandlimit(friedlander(Math.floor(0.07 * RATE), 0.004 + variant * 0.0004, cfg.heel), 18, 140 + variant * 8);
  mix(out, heel, 1, 0.004);
  const soil = mulEnv(
    bandlimit(noiseBuffer(Math.floor(cfg.dur * 0.55 * RATE), seed, 'brown'), cfg.hp, 700),
    0.001,
    0.04 + variant * 0.004
  );
  mix(out, soil, cfg.weight * 0.55, 0.006);
  gravel(out, {
    start: 0.008,
    duration: cfg.dur * 0.45,
    count: cfg.grit,
    gain: 0.12 * cfg.weight,
    hp: 600,
    lp: cfg.lp,
    seed,
  });
  const rubber = mulEnv(
    bandlimit(noiseBuffer(Math.floor(0.04 * RATE), seed + 4, 'white'), 1800, 7000),
    0.0004,
    0.012
  );
  mix(out, rubber, cfg.rubber, 0.018 + variant * 0.003);
  if (mode === 'crouch') {
    const cloth = mulEnv(bandlimit(noiseBuffer(Math.floor(0.08 * RATE), seed + 7, 'pink'), 400, 1800), 0.004, 0.05);
    mix(out, cloth, 0.12, 0.002);
  }
  return out;
}

function makeBody(id, variant) {
  const cfg = {
    'character.jump': { dur: 0.32, thud: 0.18, cloth: 0.28, gear: 0, hp: 80, lp: 1800 },
    'character.land.soft': { dur: 0.36, thud: 0.4, cloth: 0.18, gear: 0.08, hp: 50, lp: 1600 },
    'character.land.hard': { dur: 0.55, thud: 0.78, cloth: 0.22, gear: 0.22, hp: 35, lp: 2200 },
    'character.hurt': { dur: 0.42, thud: 0.5, cloth: 0.2, gear: 0.06, hp: 60, lp: 2400 },
    'character.death': { dur: 0.95, thud: 0.7, cloth: 0.3, gear: 0.28, hp: 30, lp: 2000 },
  }[id];
  const out = buffer(cfg.dur);
  const seed = hash(id + ':' + variant);
  mix(out, bandlimit(friedlander(Math.floor(0.12 * RATE), id.includes('jump') ? 0.006 : 0.008, cfg.thud), 16, 120), 1, id.includes('land') ? 0 : 0.02);
  const cloth = mulEnv(bandlimit(noiseBuffer(Math.floor(cfg.dur * 0.5 * RATE), seed, 'pink'), cfg.hp, cfg.lp), 0.004, cfg.dur * 0.28);
  mix(out, cloth, cfg.cloth, 0.01);
  if (cfg.gear) mix(out, modal(Math.floor(0.16 * RATE), [240 + variant * 20, 410, 880, 1320], 0.03, cfg.gear, seed + 3), 1, 0.03);
  if (id.includes('hard') || id.includes('death')) {
    gravel(out, { start: 0.02, duration: 0.2, count: 14, gain: 0.12, hp: 200, lp: 1800, seed: seed + 9 });
    whoosh(out, { start: 0.01, duration: 0.22, gain: 0.12, f0: 900, f1: 280, seed: seed + 11 });
  }
  if (id.includes('jump')) whoosh(out, { start: 0, duration: 0.2, gain: 0.16, f0: 400, f1: 1400, seed: seed + 2, skew: 0.7 });
  return out;
}

function makeThrowable(id, action) {
  const seed = hash('thr:' + id + ':' + action);
  if (action === 'pin') {
    const out = buffer(0.28);
    mix(out, modal(Math.floor(0.06 * RATE), id === 'frag' ? [1840, 2650] : id === 'flash' ? [2300, 3400] : [1200, 1900], 0.012, 0.28, seed), 1, 0.012);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.02 * RATE), seed + 1, 'white'), 800, 6000), 0.0002, 0.008), 0.22, 0.01);
    mix(out, modal(Math.floor(0.05 * RATE), [940, 1480], 0.01, 0.18, seed + 2), 1, 0.09);
    return out;
  }
  if (action === 'throw') {
    const out = buffer(0.26);
    whoosh(out, { start: 0, duration: 0.2, gain: id === 'frag' ? 0.28 : 0.22, f0: 500, f1: 1800, seed, skew: 0.8 });
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.08 * RATE), seed + 3, 'white'), 700, 5000), 0.001, 0.04), 0.12, 0.04);
    return out;
  }
  if (action === 'bounce') {
    const out = buffer(0.22);
    const hard = id === 'frag' ? 1 : id === 'flash' ? 0.85 : 0.55;
    mix(out, bandlimit(friedlander(Math.floor(0.05 * RATE), 0.0024, 0.45 * hard), 40, 400), 1, 0);
    mix(out, modal(Math.floor(0.08 * RATE), id === 'smoke' ? [420, 680] : [740, 1180, 1760], 0.014, 0.2 * hard, seed), 1, 0.002);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.03 * RATE), seed, 'white'), 300, 3500), 0.0002, 0.012), 0.2, 0);
    return out;
  }
  if (action === 'ring') {
    const out = buffer(1.35);
    const hiss = mulEnv(bandlimit(noiseBuffer(out.length, seed, 'white'), 2200, 9000), 0.008, 0.55);
    mix(out, hiss, 0.42, 0);
    mix(out, modal(out.length, [3180, 4120, 5470, 7810], [0.22, 0.28, 0.18, 0.12], 0.2, seed + 4), 1, 0);
    return out;
  }
  if (action === 'ignite') {
    const out = buffer(0.62);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.05 * RATE), seed, 'white'), 1500, 9000), 0.0002, 0.02), 0.35, 0.01);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.45 * RATE), seed + 2, 'pink'), 800, 7000), 0.01, 0.22), 0.4, 0.03);
    mix(out, bandlimit(friedlander(Math.floor(0.04 * RATE), 0.003, 0.18), 40, 300), 1, 0.008);
    return out;
  }

  const far = action === 'distant';
  const flash = id === 'flash';
  const out = buffer(flash ? 0.7 : far ? 2.25 : 1.85);
  mix(out, bandlimit(friedlander(Math.floor((far ? 0.22 : 0.16) * RATE), flash ? 0.0022 : far ? 0.028 : 0.016, flash ? 0.32 : far ? 0.7 : 1), 10, flash ? 220 : 90), 1, far ? 0.07 : 0);
  if (!flash) {
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor((far ? 0.9 : 0.35) * RATE), seed, 'brown'), 20, far ? 500 : 380), 0.001, far ? 0.45 : 0.14), far ? 0.55 : 0.7, far ? 0.05 : 0);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.22 * RATE), seed + 2, 'pink'), far ? 80 : 250, far ? 900 : 5200), 0.0004, far ? 0.2 : 0.08), far ? 0.28 : 0.55, far ? 0.06 : 0);
    gravel(out, {
      start: far ? 0.08 : 0.012,
      duration: far ? 0.35 : 0.32,
      count: far ? 10 : 36,
      gain: far ? 0.08 : 0.22,
      hp: far ? 200 : 500,
      lp: far ? 1400 : 7000,
      seed: seed + 6,
    });
    whoosh(out, { start: far ? 0.1 : 0.03, duration: far ? 0.7 : 0.35, gain: 0.16, f0: 700, f1: 180, seed: seed + 8 });
    comb(out, far ? [0.09, 0.17, 0.29, 0.46] : [0.03, 0.062, 0.11], far ? [0.4, 0.28, 0.18, 0.12] : [0.28, 0.18, 0.1], far ? [700, 500, 360, 240] : [3200, 1800, 900]);
    convolve(out, out.slice(0, Math.floor(0.1 * RATE)), roomIR(far ? 0.32 : 0.16, seed + 9, far ? 700 : 4000, far ? 0.1 : 0.05), far ? 0.4 : 0.2, 0);
  } else {
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.09 * RATE), seed, 'white'), 1600, 12500), 0.00012, 0.03), 0.95, 0);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.35 * RATE), seed + 3, 'pink'), 1800, 9000), 0.002, 0.12), 0.28, 0.01);
    mix(out, modal(Math.floor(0.2 * RATE), [2600, 4100, 6800], 0.04, 0.12, seed + 4), 1, 0);
  }
  return out;
}

function makeSmokeLoop() {
  const seconds = 2;
  const extra = Math.floor(0.05 * RATE);
  const total = Math.floor(seconds * RATE) + extra;
  const raw = bandlimit(noiseBuffer(total, hash('smoke-loop-v2'), 'pink'), 900, 6400);
  const steam = bandlimit(noiseBuffer(total, hash('smoke-steam'), 'brown'), 40, 280);
  const tmp = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const t = (i / RATE) % seconds;
    const mod = 0.78 + 0.22 * Math.sin((Math.PI * 2 * t) / seconds);
    tmp[i] = raw[i] * 0.34 * mod + steam[i] * 0.08;
  }
  return loopPrepare(tmp, extra);
}

function combustionLoop(type, action) {
  const cfg = {
    tank: { idle: 680, engine: 980, rev: 1380, cyl: 12, diesel: true, sub: 0.58, clatter: 0.2, air: 0.07, body: 78 },
    ifv: { idle: 760, engine: 1120, rev: 1760, cyl: 8, diesel: true, sub: 0.4, clatter: 0.14, air: 0.14, body: 96 },
    jeep: { idle: 880, engine: 1680, rev: 2680, cyl: 4, diesel: false, sub: 0.2, clatter: 0.06, air: 0.12, body: 128 },
  }[type];
  const rpm = cfg[action];
  const fireHz = (rpm / 60) * (cfg.cyl / 2);
  const nCycles = Math.max(24, Math.round(fireHz * 1.7));
  const duration = nCycles / fireHz;
  const extra = Math.floor(0.05 * RATE);
  const out = buffer(duration + extra / RATE);
  const seed = hash('eng:' + type + ':' + action);
  const bed = bandlimit(noiseBuffer(out.length, seed, 'brown'), 22, cfg.diesel ? 240 : 420);
  mix(out, bed, cfg.sub * (action === 'rev' ? 1.25 : action === 'idle' ? 0.82 : 1.08), 0);
  const air = bandlimit(noiseBuffer(out.length, seed + 3, 'pink'), cfg.diesel ? 900 : 700, cfg.diesel ? 3400 : 4200);
  mix(out, air, cfg.air * (action === 'rev' ? 1.4 : 1), 0);
  const period = 1 / fireHz;
  const pulseN = Math.floor((cfg.diesel ? 0.007 : 0.0045) * RATE);
  const totalCycles = nCycles + Math.ceil(extra / RATE / period) + 2;
  for (let c = 0; c < totalCycles; c++) {
    const t = c * period;
    if (t * RATE >= out.length) break;
    const cycle = c % nCycles;
    const wobble = 1 + 0.012 * Math.sin((Math.PI * 2 * cycle) / nCycles);
    const pulse = mulEnv(
      bandlimit(noiseBuffer(pulseN, seed + cycle * 13, cfg.diesel ? 'brown' : 'pink'), 40, cfg.diesel ? 320 : 900),
      0.0002,
      cfg.diesel ? 0.005 : 0.003
    );
    mix(out, pulse, 0.46 * wobble, t);
    if (cfg.clatter && cycle % Math.max(1, Math.round(cfg.cyl / 2)) === 0) {
      mix(out, modal(Math.floor(0.02 * RATE), [cfg.body * 1.7, cfg.body * 2.6], 0.006, cfg.clatter * 0.15, seed + cycle), 1, t + 0.001);
    }
  }
  return loopPrepare(out, extra);
}

function makeMovement(type) {
  const tracked = type !== 'jeep';
  const period = type === 'tank' ? 0.112 : type === 'ifv' ? 0.086 : 0.05;
  const nHits = type === 'jeep' ? 36 : Math.max(12, Math.round(1.8 / period));
  const duration = tracked ? nHits * period : 1.8;
  const extra = Math.max(Math.floor(0.08 * RATE), tracked ? Math.floor(period * RATE) : Math.floor(0.05 * RATE));
  const out = buffer(duration + extra / RATE);
  const seed = hash('move:' + type);
  if (tracked) {
    mix(out, bandlimit(noiseBuffer(out.length, seed, 'brown'), 30, 380), type === 'tank' ? 0.28 : 0.2, 0);
    mix(out, bandlimit(noiseBuffer(out.length, seed + 2, 'pink'), 200, 1800), 0.1, 0);
    const extraHits = nHits + Math.ceil(extra / RATE / period) + 1;
    for (let i = 0; i < extraHits; i++) {
      const t = i * period;
      if (t * RATE >= out.length) break;
      const hit = i % nHits;
      mix(out, bandlimit(friedlander(Math.floor(0.03 * RATE), 0.002, type === 'tank' ? 0.28 : 0.18), 40, 220), 1, t);
      mix(out, modal(Math.floor(0.04 * RATE), type === 'tank' ? [180, 340, 690] : [260, 480, 920], 0.012, type === 'tank' ? 0.16 : 0.12, seed + hit), 1, t);
      gravel(out, { start: t, duration: 0.03, count: 5, gain: 0.08, hp: 300, lp: 2400, seed: seed + hit * 3 });
    }
  } else {
    mix(out, bandlimit(noiseBuffer(out.length, seed, 'pink'), 80, 900), 0.32, 0);
    mix(out, bandlimit(noiseBuffer(out.length, seed + 4, 'white'), 400, 2800), 0.08, 0);
    gravel(out, { start: 0, duration: duration + extra / RATE, count: 22, gain: 0.05, hp: 500, lp: 3500, seed });
  }
  return loopPrepare(out, extra);
}

function makeEngineEvent(type, action) {
  const tracked = type !== 'jeep';
  const seed = hash('evt:' + type + ':' + action);
  if (action === 'brake') {
    const out = buffer(tracked ? 0.55 : 0.4);
    mix(out, mulEnv(bandlimit(noiseBuffer(out.length, seed, 'white'), tracked ? 180 : 1200, tracked ? 2800 : 8000), 0.01, tracked ? 0.22 : 0.12), tracked ? 0.45 : 0.32, 0);
    if (tracked) mix(out, bandlimit(friedlander(Math.floor(0.08 * RATE), 0.006, 0.22), 20, 140), 1, 0);
    return out;
  }
  const out = buffer(0.34);
  mix(out, bandlimit(friedlander(Math.floor(0.06 * RATE), 0.004, tracked ? 0.4 : 0.22), 30, 180), 1, 0.02);
  mix(out, modal(Math.floor(0.12 * RATE), tracked ? [180, 320, 540] : [420, 780, 1260], 0.02, 0.2, seed), 1, 0.03);
  mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.08 * RATE), seed, 'white'), 300, 2500), 0.001, 0.03), 0.16, 0.04);
  return out;
}

function makeVehicleWeapon(id) {
  const seed = hash('vw:' + id);
  if (id === 'tank_cannon' || id === 'tank_cannon_far') {
    const far = id.endsWith('far');
    const out = buffer(far ? 2.1 : 1.45);
    mix(out, bandlimit(friedlander(Math.floor((far ? 0.28 : 0.2) * RATE), far ? 0.032 : 0.018, far ? 0.85 : 1.25), 8, far ? 70 : 95), 1, far ? 0.08 : 0);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor((far ? 0.9 : 0.28) * RATE), seed, 'brown'), 18, far ? 420 : 320), 0.0008, far ? 0.5 : 0.16), far ? 0.62 : 0.88, far ? 0.06 : 0);
    if (!far) {
      mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.14 * RATE), seed + 2, 'white'), 220, 5800), 0.0002, 0.045), 0.62, 0);
      mix(out, modal(Math.floor(0.18 * RATE), [140, 260, 410], 0.05, 0.2, seed + 4), 1, 0.03);
    }
    gravel(out, { start: far ? 0.1 : 0.02, duration: 0.25, count: far ? 8 : 20, gain: far ? 0.06 : 0.16, hp: 250, lp: far ? 1200 : 5000, seed });
    comb(out, far ? [0.1, 0.2, 0.36] : [0.04, 0.08, 0.15], far ? [0.36, 0.22, 0.14] : [0.24, 0.14, 0.08], far ? [500, 320, 220] : [2400, 1200, 700]);
    return out;
  }
  if (id === 'tank_breech') {
    const out = buffer(0.38);
    mix(out, bandlimit(friedlander(Math.floor(0.07 * RATE), 0.004, 0.4), 40, 220), 1, 0);
    mix(out, modal(Math.floor(0.16 * RATE), [180, 340, 620, 980], 0.03, 0.28, seed), 1, 0.015);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.08 * RATE), seed, 'white'), 400, 3000), 0.001, 0.03), 0.18, 0.02);
    return out;
  }
  if (id === 'ifv_autocannon') {
    const out = buffer(0.48);
    mix(out, bandlimit(friedlander(Math.floor(0.08 * RATE), 0.0042, 0.86), 20, 160), 1, 0);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.07 * RATE), seed, 'white'), 280, 7800), 0.0002, 0.022), 0.82, 0);
    mix(out, modal(Math.floor(0.09 * RATE), [720, 1180, 1760], 0.012, 0.18, seed + 2), 1, 0.006);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.05 * RATE), seed + 5, 'pink'), 1400, 5000), 0.001, 0.02), 0.16, 0.01);
    comb(out, [0.016, 0.03], [0.16, 0.08], [4000, 2200]);
    return out;
  }
  if (id === 'ifv_missile') {
    const out = buffer(0.95);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.06 * RATE), seed, 'white'), 800, 7000), 0.0002, 0.02), 0.4, 0);
    whoosh(out, { start: 0.02, duration: 0.75, gain: 0.42, f0: 500, f1: 2400, seed: seed + 2, skew: 0.65 });
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.5 * RATE), seed + 4, 'pink'), 300, 2800), 0.02, 0.25), 0.2, 0.08);
    return out;
  }
  if (id === 'ifv_grenade') {
    const out = buffer(0.55);
    mix(out, bandlimit(friedlander(Math.floor(0.1 * RATE), 0.008, 0.62), 16, 110), 1, 0);
    whoosh(out, { start: 0.02, duration: 0.28, gain: 0.2, f0: 300, f1: 900, seed, skew: 0.8 });
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.08 * RATE), seed, 'pink'), 100, 1400), 0.002, 0.04), 0.22, 0.01);
    return out;
  }
  if (id === 'tank_hmg') return makeTankHmgReport(seed);
  const out = buffer(0.24);
  mix(out, bandlimit(friedlander(Math.floor(0.05 * RATE), 0.0028, 0.5), 30, 190), 1, 0);
  mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.04 * RATE), seed, 'white'), 300, 8000), 0.0002, 0.014), 0.62, 0);
  mix(out, modal(Math.floor(0.07 * RATE), [900, 1500, 2300], 0.01, 0.16, seed), 1, 0.004);
  return out;
}

function makeImpact(kind) {
  const seed = hash('imp:' + kind);
  const out = buffer(kind === 'armor' ? 0.55 : kind === 'structure' ? 0.7 : 0.6);
  if (kind === 'armor') {
    mix(out, bandlimit(friedlander(Math.floor(0.08 * RATE), 0.003, 0.55), 40, 260), 1, 0);
    mix(out, modal(Math.floor(0.22 * RATE), [620, 980, 1540, 2400, 3600], 0.04, 0.32, seed), 1, 0.002);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.1 * RATE), seed, 'white'), 800, 9000), 0.0002, 0.03), 0.28, 0);
  } else if (kind === 'structure') {
    mix(out, bandlimit(friedlander(Math.floor(0.12 * RATE), 0.007, 0.7), 20, 140), 1, 0);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.3 * RATE), seed, 'brown'), 40, 900), 0.002, 0.16), 0.45, 0);
    gravel(out, { start: 0.01, duration: 0.28, count: 22, gain: 0.18, hp: 200, lp: 3500, seed });
  } else {
    mix(out, bandlimit(friedlander(Math.floor(0.1 * RATE), 0.008, 0.65), 16, 110), 1, 0);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.28 * RATE), seed, 'brown'), 20, 500), 0.003, 0.14), 0.5, 0);
    gravel(out, { start: 0.01, duration: 0.2, count: 16, gain: 0.14, hp: 150, lp: 1800, seed });
  }
  return out;
}

function makeMechanic(name) {
  const seed = hash('mech:' + name);
  if (name === 'empty') {
    const out = buffer(0.16);
    mix(out, modal(Math.floor(0.05 * RATE), [1450, 2300, 3100], 0.008, 0.28, seed), 1, 0.008);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.02 * RATE), seed, 'white'), 1200, 6000), 0.00015, 0.006), 0.18, 0.007);
    return out;
  }
  if (name === 'reload_start') {
    const out = buffer(0.24);
    mix(out, modal(Math.floor(0.06 * RATE), [880, 1320], 0.012, 0.22, seed), 1, 0.01);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.05 * RATE), seed, 'white'), 400, 2800), 0.001, 0.02), 0.16, 0.03);
    return out;
  }
  if (name === 'reload_mag') {
    const out = buffer(0.32);
    mix(out, bandlimit(friedlander(Math.floor(0.05 * RATE), 0.003, 0.28), 50, 220), 1, 0.04);
    mix(out, modal(Math.floor(0.08 * RATE), [420, 760, 1180], 0.018, 0.24, seed), 1, 0.05);
    mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.06 * RATE), seed, 'pink'), 300, 2500), 0.002, 0.03), 0.14, 0.08);
    mix(out, modal(Math.floor(0.04 * RATE), [1680, 2400], 0.008, 0.14, seed + 2), 1, 0.16);
    return out;
  }
  const out = buffer(0.3);
  whoosh(out, { start: 0.02, duration: 0.1, gain: 0.12, f0: 800, f1: 1600, seed, skew: 1.2 });
  mix(out, modal(Math.floor(0.08 * RATE), [280, 640, 1100, 1750], 0.016, 0.3, seed), 1, 0.09);
  mix(out, mulEnv(bandlimit(noiseBuffer(Math.floor(0.04 * RATE), seed, 'white'), 500, 4000), 0.0003, 0.012), 0.2, 0.1);
  return out;
}

function files(prefix, count) {
  const list = [];
  for (let i = 1; i <= count; i++) list.push(prefix + String(i).padStart(2, '0') + '.wav');
  return list;
}

function sound(filesValue, category, options) {
  return Object.assign({ files: filesValue, category, bus: category }, options || {});
}

function note(family, layers) {
  return (
    'physical-model v2; family=' +
    family +
    '; layers=' +
    layers +
    '; peakLimit=0.82 lookahead-limiter; no oscillator beds / no commercial game assets'
  );
}

function csv(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function parseCsvLine(line) {
  const fields = [];
  const pattern = /"((?:[^"]|"")*)"(?:,|$)/g;
  let match;
  while ((match = pattern.exec(line))) fields.push(match[1].replace(/""/g, '"'));
  return fields;
}

const WEAPON_PROFILES = ['rifle545', 'rifle556', 'rifle762', 'pdw46', 'smg9', 'lmg556', 'dmr762', 'sniperheavy', 'pistol45'];
const GUN_FIRE_LAYERS_CLOSE = 'tankHmgMaster+friedlander+muzzleNoise+mechModes+pitchEqDur';
const GUN_FIRE_LAYERS_FAR = 'tankHmgMaster+delayed+airAbsorbedLp+pitchEqDur';

function writeInfantryFireWavs() {
  WEAPON_PROFILES.forEach((profile) => {
    const close = files('weapons/profiles/' + profile + '/fire_close_', 2);
    close.forEach((file, index) =>
      write(file, makeGun(profile, index + 1, false), {
        family: GUNS[profile].family + '.close',
        notes: note(GUNS[profile].family + '.close', GUN_FIRE_LAYERS_CLOSE),
      })
    );
    write('weapons/profiles/' + profile + '/fire_distant_01.wav', makeGun(profile, 1, true), {
      family: GUNS[profile].family + '.distant',
      notes: note(GUNS[profile].family + '.distant', GUN_FIRE_LAYERS_FAR),
    });
  });
}

function patchLicenseRows(licensePath) {
  const text = fs.readFileSync(licensePath, 'utf8').replace(/\r\n/g, '\n');
  const trailing = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const byId = Object.create(null);
  created.forEach((item) => {
    const id = item.file.replace(/\.wav$/, '');
    byId[id] = [
      id,
      'assets/sfx/' + item.file,
      'procedural',
      'Project-original',
      'Voxel Frontline audio generator',
      GENERATED_AT,
      'scripts/audio-gen/generate-sfx.js',
      item.notes,
    ]
      .map(csv)
      .join(',');
  });
  const next = lines.map((line) => {
    if (!line) return line;
    const fields = parseCsvLine(line);
    if (fields[0] && byId[fields[0]]) return byId[fields[0]];
    return line;
  });
  fs.writeFileSync(licensePath, next.join('\n') + (trailing ? '\n' : ''));
}

function generateInfantryFireOnly() {
  writeInfantryFireWavs();
  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.generatedAt = GENERATED_AT;
  manifest.generation = 'physical-model-layered-v2-hmg-family';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  patchLicenseRows(path.join(OUT, '_manifest', 'licenses.csv'));
  const preview = [
    'vehicles/weapons/tank_hmg_01.wav',
    'weapons/profiles/lmg556/fire_close_01.wav',
    'weapons/profiles/rifle545/fire_close_01.wav',
    'weapons/profiles/rifle556/fire_close_01.wav',
    'weapons/profiles/sniperheavy/fire_close_01.wav',
    'weapons/profiles/pistol45/fire_close_01.wav',
    'weapons/profiles/lmg556/fire_distant_01.wav',
  ].map((rel) => {
    const bytes = fs.readFileSync(path.join(OUT, rel));
    const n = (bytes.length - 44) / 2;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(bytes.readInt16LE(44 + i * 2) / 32768);
      if (v > peak) peak = v;
    }
    return { file: rel, dur: Number((n / RATE).toFixed(3)), peak: Number(peak.toFixed(3)), bytes: bytes.length };
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: 'infantry-fire-only',
        generatedFiles: created.length,
        generation: manifest.generation,
        ffmpeg: false,
        audacityPipe: false,
        preview,
      },
      null,
      2
    )
  );
}

if (ONLY_INFANTRY_FIRE) {
  generateInfantryFireOnly();
  process.exit(0);
}

ensure(OUT);
const sounds = {};

['walk', 'run', 'crouch'].forEach((mode) => {
  const list = files('characters/boots/' + mode + '_', 4);
  list.forEach((file, index) =>
    write(file, makeFootstep(mode, index + 1), {
      family: 'boot.' + mode + '.dirt-gravel',
      notes: note('boot.' + mode + '.v' + (index + 1), 'heelFriedlander+soilBrown+gravelGrains+rubberTransient'),
    })
  );
  sounds['character.footstep.' + mode] = sound(list, 'characters', {
    maxDistance: 35,
    priority: 2,
    gain: mode === 'run' ? 0.82 : mode === 'crouch' ? 0.42 : 0.62,
  });
});

const characterSingles = {
  'character.jump': ['characters/body/jump_01.wav'],
  'character.land.soft': ['characters/body/land_soft_01.wav'],
  'character.land.hard': ['characters/body/land_hard_01.wav'],
  'character.hurt': files('characters/body/hurt_', 2),
  'character.death': ['characters/body/death_01.wav'],
};
Object.keys(characterSingles).forEach((id) => {
  const list = characterSingles[id];
  const hard = id.includes('hard') || id.includes('death');
  list.forEach((file, index) =>
    write(file, makeBody(id, index), {
      family: 'body.' + id.replace('character.', ''),
      notes: note(id, 'impactPulse+clothNoise+gearModes+optionalDebris'),
    })
  );
  sounds[id] = sound(list, 'characters', { priority: id === 'character.death' ? 9 : id === 'character.hurt' ? 8 : 4, gain: hard ? 0.9 : 0.72 });
});

writeInfantryFireWavs();
WEAPON_PROFILES.forEach((profile) => {
  const close = files('weapons/profiles/' + profile + '/fire_close_', 2);
  const far = ['weapons/profiles/' + profile + '/fire_distant_01.wav'];
  sounds['weapon.profile.' + profile + '.fire'] = sound(close, 'weapons', {
    distantFiles: far,
    distantThreshold: profile === 'sniperheavy' ? 95 : 70,
    maxDistance: profile === 'sniperheavy' ? 420 : 280,
    priority: 7,
    gain: profile === 'sniperheavy' ? 1 : 0.82,
  });
});

const mech = {
  empty: 'weapons/mechanics/empty_01.wav',
  reload_start: 'weapons/mechanics/reload_start_01.wav',
  reload_mag: 'weapons/mechanics/reload_mag_01.wav',
  reload_rack: 'weapons/mechanics/reload_rack_01.wav',
};
Object.keys(mech).forEach((name) => {
  write(mech[name], makeMechanic(name), {
    family: 'gun.mechanic.' + name,
    notes: note('gun.mechanic.' + name, name === 'empty' ? 'dryStriker+shortMetal' : 'magBody+scrape+latchModes'),
  });
  sounds['weapon.mechanic.' + name] = sound([mech[name]], 'weapons', { maxDistance: 22, priority: 5, gain: 0.62 });
});

const weaponMap = {
  ak74: 'rifle545',
  acr: 'rifle556',
  scarh: 'rifle762',
  m4a1: 'rifle556',
  hk419: 'rifle556',
  mp7: 'pdw46',
  p90: 'pdw46',
  mp5: 'smg9',
  m249: 'lmg556',
  mk14ebr: 'dmr762',
  m200: 'sniperheavy',
  usp: 'pistol45',
};
Object.keys(weaponMap).forEach((id) => {
  sounds['weapon.' + id + '.fire'] = { alias: 'weapon.profile.' + weaponMap[id] + '.fire' };
  Object.keys(mech).forEach((action) => {
    sounds['weapon.' + id + '.' + action] = { alias: 'weapon.mechanic.' + action };
  });
});

['frag', 'flash', 'smoke'].forEach((id) => {
  ['pin', 'throw', 'bounce'].forEach((action) => {
    const file = 'throwables/' + id + '/' + action + '_01.wav';
    write(file, makeThrowable(id, action), {
      family: 'throwable.' + id + '.' + action,
      notes: note('throwable.' + id + '.' + action, action === 'pin' ? 'spoonTick+pinModes' : action === 'throw' ? 'airWhoosh+objectNoise' : 'metalImpact+dampedRing'),
    });
    sounds['throwable.' + id + '.' + action] = sound([file], 'explosives', {
      maxDistance: action === 'bounce' ? 55 : 28,
      priority: action === 'bounce' ? 3 : 5,
      gain: 0.68,
    });
  });
});
[
  ['throwable.frag.detonate', 'throwables/frag/detonate_close_01.wav', 'frag', 'detonate', 400, 9],
  ['throwable.frag.distant', 'throwables/frag/detonate_distant_01.wav', 'frag', 'distant', 450, 7],
  ['throwable.flash.detonate', 'throwables/flash/detonate_01.wav', 'flash', 'detonate', 300, 9],
  ['throwable.flash.ring', 'throwables/flash/ring_01.wav', 'flash', 'ring', 0, 9],
  ['throwable.smoke.ignite', 'throwables/smoke/ignite_01.wav', 'smoke', 'ignite', 90, 6],
].forEach((spec) => {
  write(spec[1], makeThrowable(spec[2], spec[3]), {
    family: spec[0],
    notes: note(spec[0], spec[2] === 'frag' ? 'subShock+fireball+debris+airTail' : spec[3] === 'ring' ? 'hfBandNoise+inharmonicRing' : spec[3] === 'ignite' ? 'crackle+hissSwell' : 'hfBurst+weakShock'),
  });
  sounds[spec[0]] = sound([spec[1]], spec[0].includes('ring') ? 'characters' : 'explosives', {
    maxDistance: spec[4],
    priority: spec[5],
    gain: spec[0].indexOf('detonate') >= 0 || spec[0].indexOf('distant') >= 0 ? (spec[0].indexOf('frag') >= 0 ? 1.42 : 0.86) : 0.86,
  });
});
sounds['throwable.frag.detonate'].gain = 1.42;
sounds['throwable.frag.distant'].gain = 1.18;
sounds['throwable.frag.detonate'].distantFiles = ['throwables/frag/detonate_distant_01.wav'];
sounds['throwable.frag.detonate'].distantThreshold = 70;
write('throwables/smoke/hiss_loop_01.wav', makeSmokeLoop(), {
  loop: true,
  family: 'throwable.smoke.loop',
  notes: note('throwable.smoke.loop', 'loopAlignedPinkHiss+brownSteam+periodicMod'),
});
sounds['throwable.smoke.loop'] = sound(['throwables/smoke/hiss_loop_01.wav'], 'explosives', {
  maxDistance: 55,
  priority: 3,
  gain: 0.45,
  loop: true,
});

['jeep', 'ifv', 'tank'].forEach((type) => {
  ['idle', 'engine', 'rev', 'movement', 'shift', 'brake'].forEach((action) => {
    const loop = ['idle', 'engine', 'rev', 'movement'].indexOf(action) >= 0;
    const file = 'vehicles/' + type + '/' + action + (loop ? '_loop' : '') + '_01.wav';
    const samples = action === 'movement' ? makeMovement(type) : loop ? combustionLoop(type, action) : makeEngineEvent(type, action);
    write(file, samples, {
      loop,
      family: 'vehicle.' + type + '.' + action,
      notes: note(
        'vehicle.' + type + '.' + action,
        loop
          ? action === 'movement'
            ? type === 'jeep'
              ? 'tireNoise+pebbleGrains+seamlessSeam'
              : 'trackHits+metalModes+dirtGravel+combustionBed'
            : 'rpmAlignedCombustionPulses+brownExhaust+airIntake+loopSeam'
          : action === 'brake'
            ? 'frictionNoise+optionalTrackGrind'
            : 'gearThud+meshModes'
      ),
    });
    sounds['vehicle.' + type + '.' + action] = sound([file], 'vehicles', {
      maxDistance: 190,
      priority: loop ? 2 : 4,
      gain: action === 'movement' ? 0.45 : 0.56,
      loop,
    });
  });
});

const vehicleWeapons = ['tank_cannon', 'tank_cannon_far', 'tank_breech', 'tank_coax', 'tank_hmg', 'ifv_autocannon', 'ifv_missile', 'ifv_grenade'];
vehicleWeapons.forEach((id) => {
  const file = 'vehicles/weapons/' + id + '_01.wav';
  write(file, makeVehicleWeapon(id), {
    family: 'vehicle.weapon.' + id,
    notes: note('vehicle.weapon.' + id, id.includes('cannon') ? 'heavyFriedlander+boomBed+debris+comb' : id.includes('missile') ? 'ignite+movingBandWhoosh' : 'shortBlast+mechModes'),
  });
  sounds['vehicle.weapon.' + id] = sound([file], 'vehicles', {
    maxDistance: id.includes('cannon') ? 450 : 300,
    priority: id.includes('cannon') ? 10 : 7,
    gain: id.includes('cannon') ? 1.22 : 1.15,
  });
});
sounds['vehicle.weapon.tank_cannon'].distantFiles = ['vehicles/weapons/tank_cannon_far_01.wav'];
sounds['vehicle.weapon.tank_cannon'].distantThreshold = 78;
sounds['vehicle.explosion.cannon'] = sound(['vehicles/weapons/tank_cannon_01.wav'], 'explosives', {
  maxDistance: 450,
  priority: 10,
  gain: 1.45,
});
sounds['vehicle.explosion.cannon'].distantFiles = ['vehicles/weapons/tank_cannon_far_01.wav'];
sounds['vehicle.explosion.cannon'].distantThreshold = 72;
sounds['vehicle.explosion.he'] = sound(['throwables/frag/detonate_close_01.wav'], 'explosives', {
  maxDistance: 420,
  priority: 10,
  gain: 1.4,
});
sounds['vehicle.explosion.he'].distantFiles = ['throwables/frag/detonate_distant_01.wav'];
sounds['vehicle.explosion.he'].distantThreshold = 70;
['armor', 'ground', 'structure'].forEach((kind) => {
  const file = 'vehicles/impacts/' + kind + '_01.wav';
  write(file, makeImpact(kind), {
    family: 'vehicle.impact.' + kind,
    notes: note('vehicle.impact.' + kind, kind === 'armor' ? 'metalModes+brightTransient' : 'soilShock+debrisGrains'),
  });
  sounds['vehicle.impact.' + kind] = sound([file], 'vehicles', { maxDistance: 330, priority: 7, gain: 0.95 });
});

const manifest = {
  version: 2,
  generatedAt: GENERATED_AT,
  generation: 'physical-model-layered-v2-hmg-family',
  basePath: 'assets/sfx/',
  format: 'wav-pcm16-mono-44100',
  fallbackPolicy: 'procedural',
  buses: {
    ui: 0.78,
    weapons: 0.86,
    characters: 0.72,
    explosives: 1.12,
    vehicles: 0.96,
  },
  concurrency: {
    global: 32,
    ui: 4,
    weapons: 12,
    characters: 8,
    explosives: 7,
    vehicles: 10,
  },
  weaponProfiles: weaponMap,
  sounds,
};
ensure(path.join(OUT, '_manifest'));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const licenseRows = [['asset_id', 'path', 'source_type', 'license', 'author', 'generated_utc', 'generator', 'notes']].concat(
  created.map((item) => [
    item.file.replace(/\.wav$/, ''),
    'assets/sfx/' + item.file,
    'procedural',
    'Project-original',
    'Voxel Frontline audio generator',
    GENERATED_AT,
    'scripts/audio-gen/generate-sfx.js',
    item.notes,
  ])
);
licenseRows.push([
  '_source/audacity_batch_source',
  'assets/sfx/_source/audacity_batch_source.wav',
  'procedural',
  'Project-original',
  'Voxel Frontline audio generator',
  GENERATED_AT,
  'scripts/audio-gen/generate-sfx.js',
  note('audacity.batch-source', 'unmastered mix of gun+step+frag+engine for manual Audacity polish'),
]);
fs.writeFileSync(path.join(OUT, '_manifest', 'licenses.csv'), licenseRows.map((row) => row.map(csv).join(',')).join('\n') + '\n');

const proof = buffer(1.6);
mix(proof, makeGun('rifle545', 1, false), 0.55, 0);
mix(proof, makeFootstep('run', 1), 0.35, 0.22);
mix(proof, makeThrowable('frag', 'detonate'), 0.4, 0.42);
mix(proof, combustionLoop('tank', 'engine').subarray(0, Math.floor(1.2 * RATE)), 0.22, 0.05);
ensure(path.join(OUT, '_source'));
dcBlock(proof);
fs.writeFileSync(path.join(OUT, '_source', 'audacity_batch_source.wav'), wav(proof));

function bandShare(samples) {
  let low = 0;
  let mid = 0;
  let high = 0;
  let lp = 0;
  let midp = 0;
  const aL = 1 - Math.exp((-Math.PI * 2 * 150) / RATE);
  const aM = 1 - Math.exp((-Math.PI * 2 * 2000) / RATE);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    lp += aL * (x - lp);
    midp += aM * (x - midp);
    const l = lp;
    const m = midp - lp;
    const h = x - midp;
    low += l * l;
    mid += m * m;
    high += h * h;
  }
  const tot = low + mid + high || 1;
  let peak = 0;
  let sum2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] < 0 ? -samples[i] : samples[i];
    if (v > peak) peak = v;
    sum2 += samples[i] * samples[i];
  }
  return {
    dur: Number((samples.length / RATE).toFixed(3)),
    peak: Number(peak.toFixed(3)),
    rms: Number(Math.sqrt(sum2 / samples.length).toFixed(3)),
    low: Number((low / tot).toFixed(3)),
    mid: Number((mid / tot).toFixed(3)),
    high: Number((high / tot).toFixed(3)),
  };
}

function inspectWritten(rel) {
  const bytes = fs.readFileSync(path.join(OUT, rel));
  const n = (bytes.length - 44) / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = bytes.readInt16LE(44 + i * 2) / 32768;
  return Object.assign({ file: rel }, bandShare(samples));
}

const preview = [
  'weapons/profiles/rifle545/fire_close_01.wav',
  'weapons/profiles/rifle556/fire_close_01.wav',
  'weapons/profiles/sniperheavy/fire_close_01.wav',
  'weapons/profiles/pistol45/fire_close_01.wav',
  'characters/boots/run_01.wav',
  'throwables/frag/detonate_close_01.wav',
  'throwables/flash/detonate_01.wav',
  'vehicles/tank/engine_loop_01.wav',
  'vehicles/weapons/tank_cannon_01.wav',
  'vehicles/weapons/ifv_autocannon_01.wav',
].map(inspectWritten);

console.log(
  JSON.stringify(
    {
      ok: true,
      generatedFiles: created.length,
      format: manifest.format,
      generation: manifest.generation,
      ffmpeg: false,
      audacityPipe: false,
      manifestSounds: Object.keys(sounds).length,
      output: path.relative(ROOT, OUT),
      preview,
    },
    null,
    2
  )
);
