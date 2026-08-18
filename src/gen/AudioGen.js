import { Rng } from './Rng.js';

/**
 * AudioGen — procedural sound synthesis into raw Float32 sample buffers.
 *
 * Pure maths, no AudioContext required, so the generators are unit-testable in
 * Node and work identically on a device that has not yet unlocked audio.
 * AudioSystem (S8) wraps these buffers in AudioBuffers and handles playback.
 */

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/** One-pole low-pass. `cut` is normalised cutoff in (0, 1]. */
function lowpass(buf, cut) {
  let y = 0;
  const a = Math.min(1, Math.max(0.0001, cut));
  for (let i = 0; i < buf.length; i++) { y += a * (buf[i] - y); buf[i] = y; }
  return buf;
}

/** One-pole high-pass (input minus its low-passed self). */
function highpass(buf, cut) {
  let y = 0;
  const a = Math.min(1, Math.max(0.0001, cut));
  for (let i = 0; i < buf.length; i++) { y += a * (buf[i] - y); buf[i] -= y; }
  return buf;
}

/** State-variable band-pass — used for surface-tinted footsteps and clicks. */
function bandpass(buf, freq, sr, q = 3) {
  const f = 2 * Math.sin(Math.PI * Math.min(freq / sr, 0.45));
  const damp = 1 / q;
  let low = 0, band = 0;
  for (let i = 0; i < buf.length; i++) {
    const input = buf[i];
    low += f * band;
    const high = input - low - damp * band;
    band += f * high;
    buf[i] = band;
  }
  return buf;
}

function normalize(buf, peak = 0.92) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  if (m < 1e-6) return buf;
  const k = peak / m;
  for (let i = 0; i < buf.length; i++) buf[i] *= k;
  return buf;
}

/** Soft clip — adds harmonics and keeps transients from cracking. */
function saturate(buf, drive = 1.6) {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) / Math.tanh(drive);
  return buf;
}

/**
 * Asymmetric declick. The fade-in must stay very short: percussive voices peak
 * on the first few samples, and a long fade-in would eat the transient (and,
 * if normalisation ran afterwards, the whole sound's level with it).
 */
function fadeEdges(buf, sr, outMs = 3, inMs = 0.4) {
  const nIn = Math.min(Math.floor(sr * inMs / 1000), Math.floor(buf.length / 2));
  const nOut = Math.min(Math.floor(sr * outMs / 1000), Math.floor(buf.length / 2));
  for (let i = 0; i < nIn; i++) buf[i] *= i / nIn;
  for (let i = 0; i < nOut; i++) buf[buf.length - 1 - i] *= i / nOut;
  return buf;
}

/** Pink-ish noise via the Voss-McCartney approximation. */
function pinkNoise(n, rng) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* voices                                                              */
/* ------------------------------------------------------------------ */

/**
 * Gunshot: a transient noise crack, a pitched body thump that drops in
 * frequency, and a filtered tail whose length scales with the calibre.
 */
function gunshot(sr, o) {
  const {
    duration = 0.30, bodyFreq = 150, bodyDrop = 0.55, crack = 1.0,
    tail = 0.45, bright = 0.55, seed = 1, punch = 1.0,
  } = o;
  const n = Math.floor(sr * duration);
  const buf = new Float32Array(n);
  const rng = new Rng(seed);

  // Transient crack: white noise through a downward-sweeping low-pass.
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = rng.next() * 2 - 1;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const cut = Math.max(0.02, bright * Math.pow(1 - t, 1.4));
    y += cut * (noise[i] - y);
    const env = Math.exp(-t * 34 / crack);
    buf[i] += y * env * 0.9 * crack;
  }

  // Body: sine dropping in pitch, gives the shot its weight.
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = bodyFreq * (1 - bodyDrop * t);
    phase += (2 * Math.PI * f) / sr;
    buf[i] += Math.sin(phase) * Math.exp(-t * 20) * 0.75 * punch;
  }

  // Tail: pink noise, band-limited, decaying slowly — the room reflection.
  const tl = pinkNoise(n, new Rng(o.seed ^ 0x51ed));
  lowpass(tl, 0.16);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    buf[i] += tl[i] * Math.exp(-t * 7 / tail) * 0.5 * tail;
  }

  saturate(buf, 1.5);
  highpass(buf, 0.02);
  return normalize(fadeEdges(buf, sr), 0.95);
}

/** Short mechanical click — reload steps, UI, pickup. */
function click(sr, o) {
  const { duration = 0.07, freq = 900, q = 4, decay = 60, seed = 3, noiseMix = 0.7 } = o;
  const n = Math.floor(sr * duration);
  const rng = new Rng(seed);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = (rng.next() * 2 - 1) * noiseMix;
  bandpass(buf, freq, sr, q);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    phase += (2 * Math.PI * freq) / sr;
    buf[i] = (buf[i] + Math.sin(phase) * (1 - noiseMix)) * Math.exp(-t * decay);
  }
  return normalize(fadeEdges(buf, sr, 1.5), 0.7);
}

/** Footstep: band-limited noise burst tinted by the surface. */
function footstep(sr, o) {
  const { duration = 0.16, freq = 320, q = 1.6, seed = 5, decay = 26, grit = 0.4 } = o;
  const n = Math.floor(sr * duration);
  const rng = new Rng(seed);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = rng.next() * 2 - 1;
  bandpass(buf, freq, sr, q);
  const hi = new Float32Array(n);
  for (let i = 0; i < n; i++) hi[i] = rng.next() * 2 - 1;
  bandpass(hi, freq * 6, sr, 2.5);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    buf[i] = (buf[i] + hi[i] * grit) * Math.exp(-t * decay) * (1 - Math.exp(-t * 400));
  }
  return normalize(fadeEdges(buf, sr), 0.6);
}

/** Resonant impact — building placement, harvesting, structure damage. */
function impact(sr, o) {
  const { duration = 0.34, partials = [180, 271, 393, 604], decay = 12, seed = 9, noise = 0.35, metallic = 0 } = o;
  const n = Math.floor(sr * duration);
  const buf = new Float32Array(n);
  const rng = new Rng(seed);
  for (let p = 0; p < partials.length; p++) {
    const f = partials[p] * (1 + (rng.next() - 0.5) * 0.05);
    const amp = 1 / (p + 1);
    const d = decay * (1 + p * (metallic ? 0.12 : 0.55));
    let phase = rng.next() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      phase += (2 * Math.PI * f) / sr;
      buf[i] += Math.sin(phase) * amp * Math.exp(-t * d);
    }
  }
  const nz = new Float32Array(n);
  for (let i = 0; i < n; i++) nz[i] = rng.next() * 2 - 1;
  bandpass(nz, partials[0] * 3, sr, 1.4);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    buf[i] += nz[i] * noise * Math.exp(-t * 40);
  }
  saturate(buf, 1.2);
  return normalize(fadeEdges(buf, sr), 0.75);
}

/** FM blip — UI confirmations, hitmarkers, elimination stinger notes. */
function blip(sr, o) {
  const { duration = 0.16, freq = 660, ratio = 2.0, index = 3.0, decay = 18, sweep = 0 } = o;
  const n = Math.floor(sr * duration);
  const buf = new Float32Array(n);
  let cPhase = 0, mPhase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = freq * (1 + sweep * t);
    mPhase += (2 * Math.PI * f * ratio) / sr;
    const mod = Math.sin(mPhase) * index * Math.exp(-t * decay * 0.6);
    cPhase += (2 * Math.PI * f) / sr;
    buf[i] = Math.sin(cPhase + mod) * Math.exp(-t * decay);
  }
  return normalize(fadeEdges(buf, sr, 2), 0.65);
}

/** Seamless looping wind/storm bed: pink noise shaped by slow LFOs. */
function windLoop(sr, o) {
  const { duration = 4.0, seed = 11, lowCut = 0.05, motion = 0.35, tone = 1.0 } = o;
  const n = Math.floor(sr * duration);
  const rng = new Rng(seed);
  const buf = pinkNoise(n, rng);
  lowpass(buf, lowCut * tone);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Two incommensurate LFOs whose periods both divide the loop length.
    const lfo = 1 + motion * (Math.sin(t * Math.PI * 2 * 2) * 0.6 + Math.sin(t * Math.PI * 2 * 3) * 0.4);
    buf[i] *= lfo;
  }
  // Crossfade the tail into the head so the loop point is inaudible.
  const fade = Math.floor(sr * 0.35);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    buf[i] = buf[i] * k + buf[n - fade + i] * (1 - k);
  }
  return normalize(buf.subarray(0, n - fade), 0.45);
}

/** Downward noise sweep — glider deploy, storm closing warning. */
function sweep(sr, o) {
  const { duration = 1.2, from = 2400, to = 180, seed = 13, res = 3.5 } = o;
  const n = Math.floor(sr * duration);
  const rng = new Rng(seed);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = rng.next() * 2 - 1;
  // Time-varying SVF sweep.
  let low = 0, band = 0;
  const damp = 1 / res;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const freq = from * Math.pow(to / from, t);
    const f = 2 * Math.sin(Math.PI * Math.min(freq / sr, 0.45));
    low += f * band;
    const high = buf[i] - low - damp * band;
    band += f * high;
    buf[i] = band * Math.min(1, t * 6) * (1 - t * 0.4);
  }
  return normalize(fadeEdges(buf, sr, 20), 0.55);
}

/* ------------------------------------------------------------------ */
/* library                                                             */
/* ------------------------------------------------------------------ */

/** Named sound recipes. Values are chosen to read as distinct at a glance. */
export const SOUNDS = {
  shot_ar: (sr) => gunshot(sr, { duration: 0.26, bodyFreq: 155, crack: 1.0, tail: 0.42, bright: 0.60, seed: 101 }),
  shot_smg: (sr) => gunshot(sr, { duration: 0.18, bodyFreq: 190, crack: 0.8, tail: 0.28, bright: 0.72, seed: 102, punch: 0.7 }),
  shot_shotgun: (sr) => gunshot(sr, { duration: 0.46, bodyFreq: 95, crack: 1.35, tail: 0.9, bright: 0.44, seed: 103, punch: 1.5 }),
  shot_sniper: (sr) => gunshot(sr, { duration: 0.85, bodyFreq: 78, crack: 1.5, tail: 1.6, bright: 0.5, seed: 104, punch: 1.7 }),
  shot_pistol: (sr) => gunshot(sr, { duration: 0.21, bodyFreq: 210, crack: 0.9, tail: 0.3, bright: 0.66, seed: 105, punch: 0.8 }),

  reload_out: (sr) => click(sr, { freq: 520, decay: 40, seed: 201, duration: 0.10 }),
  reload_in: (sr) => click(sr, { freq: 340, decay: 30, seed: 202, duration: 0.13, q: 2.5 }),
  reload_bolt: (sr) => click(sr, { freq: 1500, decay: 55, seed: 203, duration: 0.09, q: 6 }),
  dry_fire: (sr) => click(sr, { freq: 2200, decay: 90, seed: 204, duration: 0.05, q: 7 }),

  step_grass: (sr) => footstep(sr, { freq: 260, q: 1.1, seed: 301, grit: 0.55 }),
  step_dirt: (sr) => footstep(sr, { freq: 200, q: 1.3, seed: 302, grit: 0.4 }),
  step_wood: (sr) => footstep(sr, { freq: 420, q: 2.4, seed: 303, grit: 0.25, decay: 20 }),
  step_metal: (sr) => footstep(sr, { freq: 900, q: 4.0, seed: 304, grit: 0.2, decay: 16 }),

  build_wood: (sr) => impact(sr, { partials: [150, 232, 348, 470], decay: 14, seed: 401, noise: 0.4 }),
  build_brick: (sr) => impact(sr, { partials: [110, 190, 305, 402], decay: 20, seed: 402, noise: 0.55 }),
  build_metal: (sr) => impact(sr, { partials: [220, 447, 691, 1103], decay: 6, seed: 403, noise: 0.25, metallic: 1 }),
  build_break: (sr) => impact(sr, { duration: 0.5, partials: [90, 143, 219, 330], decay: 9, seed: 404, noise: 0.8 }),

  harvest: (sr) => impact(sr, { duration: 0.22, partials: [260, 390, 520], decay: 26, seed: 405, noise: 0.5 }),
  pickup: (sr) => blip(sr, { freq: 720, ratio: 1.5, index: 2.0, decay: 16, sweep: 0.45 }),
  hitmarker: (sr) => blip(sr, { duration: 0.08, freq: 1500, ratio: 3, index: 1.4, decay: 42 }),
  headshot: (sr) => blip(sr, { duration: 0.14, freq: 2100, ratio: 2.5, index: 2.2, decay: 26, sweep: 0.3 }),
  hurt: (sr) => blip(sr, { duration: 0.2, freq: 190, ratio: 1.2, index: 4.5, decay: 14, sweep: -0.35 }),
  eliminate: (sr) => blip(sr, { duration: 0.5, freq: 440, ratio: 1.5, index: 2.6, decay: 6, sweep: 0.55 }),
  shield: (sr) => blip(sr, { duration: 0.6, freq: 520, ratio: 2.02, index: 1.2, decay: 5, sweep: 0.7 }),
  ui_tap: (sr) => click(sr, { duration: 0.05, freq: 1200, decay: 80, seed: 501, q: 5, noiseMix: 0.35 }),
  ui_confirm: (sr) => blip(sr, { duration: 0.18, freq: 880, ratio: 1.5, index: 1.0, decay: 14, sweep: 0.5 }),

  storm_loop: (sr) => windLoop(sr, { duration: 4.0, seed: 601, lowCut: 0.045, motion: 0.42 }),
  wind_loop: (sr) => windLoop(sr, { duration: 4.0, seed: 602, lowCut: 0.10, motion: 0.28, tone: 1.6 }),
  glider: (sr) => sweep(sr, { duration: 1.1, from: 3000, to: 300, seed: 701, res: 2.2 }),
  storm_warn: (sr) => sweep(sr, { duration: 1.8, from: 300, to: 90, seed: 702, res: 5.0 }),
};

export class AudioGen {
  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.cache = new Map();
  }

  /** Synthesise (or fetch from cache) a named sound as a Float32Array. */
  get(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const fn = SOUNDS[name];
    if (!fn) throw new Error(`Unknown sound "${name}"`);
    const buf = fn(this.sampleRate);
    this.cache.set(name, buf);
    return buf;
  }

  has(name) { return name in SOUNDS; }
  names() { return Object.keys(SOUNDS); }
  clear() { this.cache.clear(); }
}

export { gunshot, click, footstep, impact, blip, windLoop, sweep, pinkNoise, normalize };
