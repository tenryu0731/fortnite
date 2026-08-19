/**
 * Rng — PCG32 (XSH-RR) seeded generator.
 *
 * Every random value in the game comes from one of these. Global Math.random()
 * is banned (tests/unit.cjs greps for it) so that a given `?seed=` reproduces
 * the world exactly, which is the precondition for screenshot regression.
 *
 * `stream(tag)` derives an independent child generator. Subsystems take their
 * own stream so that changing how many numbers one of them consumes cannot
 * shift the output of any other.
 */

const MUL_HI = 0x5851f42d;
const MUL_LO = 0x4c957f2d;

/** 64-bit multiply/add on a pair of uint32s, kept in two halves. */
function mul64(hi, lo, mHi, mLo) {
  const l0 = lo & 0xffff, l1 = lo >>> 16;
  const m0 = mLo & 0xffff, m1 = mLo >>> 16;
  let c0 = l0 * m0;
  let c1 = (c0 >>> 16) + l0 * m1;
  let c2 = c1 >>> 16;
  c1 = (c1 & 0xffff) + l1 * m0;
  c2 += c1 >>> 16;
  const outLo = ((c1 & 0xffff) << 16) | (c0 & 0xffff);
  const outHi = (c2 + l1 * m1 + Math.imul(hi, mLo) + Math.imul(lo, mHi)) >>> 0;
  return [outHi, outLo >>> 0];
}

function add64(hi, lo, aHi, aLo) {
  const l = (lo >>> 0) + (aLo >>> 0);
  return [(hi + aHi + (l > 0xffffffff ? 1 : 0)) >>> 0, l >>> 0];
}

/** FNV-1a over a string — used to turn stream tags into seeds. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed = 1) {
    this.seed(seed);
  }

  seed(seed) {
    const s = (seed >>> 0) || 1;
    this._baseSeed = s;
    // PCG32 init: state = 0; advance; state += seed; advance.
    this._hi = 0;
    this._lo = 0;
    this._incHi = 0x14057b7e;
    this._incLo = 0xf767814f;
    this._next32();
    [this._hi, this._lo] = add64(this._hi, this._lo, 0, s);
    this._next32();
    this._gauss = null;
    return this;
  }

  _next32() {
    const oldHi = this._hi, oldLo = this._lo;
    let [hi, lo] = mul64(oldHi, oldLo, MUL_HI, MUL_LO);
    [hi, lo] = add64(hi, lo, this._incHi, this._incLo);
    this._hi = hi; this._lo = lo;

    // XSH-RR: x = ((state >> 18) ^ state) >> 27, rotated right by (state >> 59).
    const tHi = oldHi >>> 18;
    const tLo = ((oldLo >>> 18) | (oldHi << 14)) >>> 0;
    const xHi = (tHi ^ oldHi) >>> 0;
    const xLo = (tLo ^ oldLo) >>> 0;
    const xorshifted = (((xLo >>> 27) | (xHi << 5)) >>> 0);
    const rot = oldHi >>> 27;
    return (((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0);
  }

  /** Uniform in [0, 1). 32-bit resolution is ample for content generation. */
  next() { return this._next32() / 4294967296; }

  int(n) { return Math.floor(this.next() * n); }
  range(a, b) { return a + this.next() * (b - a); }
  intRange(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }

  /** Weighted pick. `weights[i]` corresponds to `arr[i]`; need not sum to 1. */
  pickWeighted(arr, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Standard normal via Box-Muller, caching the second sample. */
  gauss(mean = 0, sd = 1) {
    if (this._gauss !== null) { const g = this._gauss; this._gauss = null; return mean + g * sd; }
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * v;
    this._gauss = r * Math.sin(th);
    return mean + r * Math.cos(th) * sd;
  }

  /** Uniform point on a unit disc — used for spread cones and scatter. */
  disc(out = { x: 0, y: 0 }) {
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(this.next());
    out.x = Math.cos(a) * r; out.y = Math.sin(a) * r;
    return out;
  }

  /** Independent child stream. Same tag + same parent seed => same sequence. */
  stream(tag) {
    return Rng.forStream(this._baseSeed, tag);
  }

  static forStream(baseSeed, tag) {
    const r = new Rng(((baseSeed >>> 0) ^ hashString(tag)) >>> 0);
    r._baseSeed = baseSeed >>> 0;
    return r;
  }
}

/** Root generator factory — records the base seed so `stream()` stays stable. */
export function makeRoot(seed) {
  const r = new Rng(seed);
  r._baseSeed = seed >>> 0;
  return r;
}
