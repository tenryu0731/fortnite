import { Rng } from './Rng.js';

/**
 * Noise — seeded gradient/value/worley noise plus fBm helpers.
 *
 * Two families are provided:
 *  - `perlin2/3`, `simplex2` for world-space fields (terrain, biomes, scatter)
 *  - `perlin2Tile` for texture synthesis, which wraps on a lattice period so
 *    generated textures tile seamlessly (ARCHITECTURE.md 4.3).
 */

const GRAD2 = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 0, 1, 0, -1,
]);

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

export class Noise {
  constructor(seed = 1) {
    const rng = new Rng(seed);
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    this.seed = seed;
  }

  _g2(hash, x, y) {
    const h = (hash & 7) << 1;
    return GRAD2[h] * x + GRAD2[h + 1] * y;
  }

  _g3(hash, x, y, z) {
    const h = (hash % 12) * 3;
    return GRAD3[h] * x + GRAD3[h + 1] * y + GRAD3[h + 2] * z;
  }

  /** Classic 2D Perlin in [-1, 1]. */
  perlin2(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const p = this.perm;
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    const x1 = lerp(this._g2(aa, xf, yf), this._g2(ba, xf - 1, yf), u);
    const x2 = lerp(this._g2(ab, xf, yf - 1), this._g2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  /**
   * Periodic 2D Perlin: lattice coordinates wrap at (px, py), so sampling the
   * full period produces a seamlessly tileable image.
   */
  perlin2Tile(x, y, px, py) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    // Single-branch wrap: callers sample within one period, so a full modulo
    // pair is wasted work in the inner loop of texture synthesis.
    let X0 = xi % px; if (X0 < 0) X0 += px;
    let Y0 = yi % py; if (Y0 < 0) Y0 += py;
    const X1 = (X0 + 1) % px, Y1 = (Y0 + 1) % py;
    const p = this.perm;
    const aa = p[(p[X0 & 255] + Y0) & 255], ab = p[(p[X0 & 255] + Y1) & 255];
    const ba = p[(p[X1 & 255] + Y0) & 255], bb = p[(p[X1 & 255] + Y1) & 255];
    const x1 = lerp(this._g2(aa, xf, yf), this._g2(ba, xf - 1, yf), u);
    const x2 = lerp(this._g2(ab, xf, yf - 1), this._g2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  perlin3(x, y, z) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y), zf = z - Math.floor(z);
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const p = this.perm;
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return lerp(
      lerp(
        lerp(this._g3(p[AA], xf, yf, zf), this._g3(p[BA], xf - 1, yf, zf), u),
        lerp(this._g3(p[AB], xf, yf - 1, zf), this._g3(p[BB], xf - 1, yf - 1, zf), u), v),
      lerp(
        lerp(this._g3(p[AA + 1], xf, yf, zf - 1), this._g3(p[BA + 1], xf - 1, yf, zf - 1), u),
        lerp(this._g3(p[AB + 1], xf, yf - 1, zf - 1), this._g3(p[BB + 1], xf - 1, yf - 1, zf - 1), u), v),
      w);
  }

  /** 2D simplex in [-1, 1] — cheaper and less axis-aligned than Perlin. */
  simplex2(xin, yin) {
    const p = this.perm;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { t0 *= t0; n += t0 * t0 * this._g2(p[ii + p[jj]], x0, y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { t1 *= t1; n += t1 * t1 * this._g2(p[ii + i1 + p[jj + j1]], x1, y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { t2 *= t2; n += t2 * t2 * this._g2(p[ii + 1 + p[jj + 1]], x2, y2); }
    return 70 * n;
  }

  /** Fractional Brownian motion over simplex2. Result stays in about [-1, 1]. */
  fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2(x * freq, y * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  fbmTile(x, y, px, py, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, sum = 0, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.perlin2Tile(x * f, y * f, px * f, py * f);
      norm += amp;
      amp *= gain; f *= lacunarity;
    }
    return sum / norm;
  }

  /** Tileable ridged multifractal — bark grooves and other wrapping surfaces. */
  ridgedTile(x, y, px, py, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, sum = 0, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      const v = 1 - Math.abs(this.perlin2Tile(x * f, y * f, px * f, py * f));
      sum += amp * v * v;
      norm += amp;
      amp *= gain; f *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal — sharp crests, used for mountain ranges. */
  ridged2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.simplex2(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Billowy noise — rounded lumps, good for clouds and rock lumps. */
  billow2(x, y, octaves = 4) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * Math.abs(this.simplex2(x * freq, y * freq));
      norm += amp;
      amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  }

  /**
   * Worley (cellular) F1 distance, cell size 1. Returns distance to the nearest
   * feature point; used for cracked rock, brick jitter and foliage clumping.
   */
  worley2(x, y, period = 0) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let best = 8;
    const p = this.perm;
    const INV = 1 / 255;
    for (let dy = -1; dy <= 1; dy++) {
      let cy = yi + dy;
      if (period > 0) { cy %= period; if (cy < 0) cy += period; }
      const fyBase = yi + dy;
      for (let dx = -1; dx <= 1; dx++) {
        let cx = xi + dx;
        if (period > 0) { cx %= period; if (cx < 0) cx += period; }
        const h = p[(p[cx & 255] + cy) & 255];
        const h2 = p[(h + 37) & 255];
        const ddx = (xi + dx + h * INV) - x;
        const ddy = (fyBase + h2 * INV) - y;
        const d = ddx * ddx + ddy * ddy;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }
}

/** Smoothstep, clamped. */
export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerpN(a, b, t) { return a + (b - a) * t; }
