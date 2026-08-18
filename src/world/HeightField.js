import { Noise, smoothstep, clamp } from '../gen/Noise.js';
import { classify, SEA_LEVEL } from './Biome.js';

/**
 * HeightField — the authoritative terrain elevation and moisture data.
 *
 * A single island on a `size` x `size` metre square sampled every `step`
 * metres. Shape is composed from:
 *   - a radial continent mask, so the playfield is bounded by water rather than
 *     an invisible wall;
 *   - low-frequency rolling hills;
 *   - a ridged mountain band weighted towards one quadrant;
 *   - river channels carved by an inverted ridge field;
 *   - explicit flattening pads reserved by POI placement (S3).
 *
 * Everything downstream (terrain meshes, physics, AI pathing, scatter, minimap)
 * reads through this, so it is generated once and never mutated after
 * `bake()` other than by `flatten()` during world construction.
 */
export class HeightField {
  constructor(seed, { size = 1024, step = 2 } = {}) {
    this.size = size;
    this.step = step;
    this.half = size / 2;
    this.dim = Math.floor(size / step) + 1;      // inclusive sample grid
    this.height = new Float32Array(this.dim * this.dim);
    this.moisture = new Float32Array(this.dim * this.dim);
    this.noise = new Noise(seed ^ 0x517cc1b7);
    this.moistNoise = new Noise(seed ^ 0x27d4eb2f);
    this.seed = seed;
    this.maxHeight = 0;
    this._pads = [];
  }

  /** Raw shape function in world metres — also used to preview before baking. */
  sampleRaw(x, z) {
    const n = this.noise;
    const s = 1 / this.size;
    let nx = x * s, nz = z * s;

    // Domain warp. Sampling the terrain fields through a low-frequency offset
    // breaks up the axis-aligned streaking that plain ridged noise produces and
    // is what makes the massifs read as eroded rather than extruded.
    const wx = n.fbm2(nx * 1.7 + 12, nz * 1.7 - 31, 2);
    const wz = n.fbm2(nx * 1.7 - 55, nz * 1.7 + 74, 2);
    nx += wx * 0.14;
    nz += wz * 0.14;

    // Island mask: 1 inland, 0 past the shoreline. The coast wobble keeps the
    // outline from reading as a circle.
    const d = Math.hypot(x, z) / this.half;
    const coast = n.fbm2(nx * 3.4 + 40, nz * 3.4 - 17, 3) * 0.11;
    // The hard edge term guarantees zero land beyond 0.94 of the map radius no
    // matter how the coast wobble lands, which the rim test in gameplay.cjs
    // relies on: the play space must never include open ocean.
    const mask = smoothstep(1.02, 0.66, d + coast) * smoothstep(0.94, 0.80, d);

    // Rolling base terrain: the majority of the playable surface.
    let h = n.fbm2(nx * 2.4, nz * 2.4, 5) * 0.5 + 0.5;
    h = Math.pow(h, 1.25) * 26;
    // Mid-scale hills: the relief a player actually walks over and fights on.
    const hills = n.fbm2(nx * 5.2 + 70, nz * 5.2 - 40, 3) * 0.5 + 0.5;
    h += hills * hills * 17;

    // Massifs. A broad smoothstep blob supplies the mass and a low-amplitude
    // ridge supplies surface texture, so peaks are rounded rather than needles.
    const regionRaw = n.fbm2(nx * 1.35 - 90, nz * 1.35 + 60, 3) * 0.5 + 0.5;
    const region = smoothstep(0.32, 0.74, regionRaw);
    const massif = smoothstep(0.42, 0.74, n.fbm2(nx * 2.1 + 210, nz * 2.1 - 140, 3) * 0.5 + 0.5);
    const ridge = n.ridged2(nx * 3.6 + 11, nz * 3.6 - 5, 4);
    const mountain = region * massif;
    h += mountain * 66;
    h += mountain * ridge * 18;

    // Terrace the mid band so there are flat places to fight and build on.
    // A hard round() would leave visible contour steps, so the riser between
    // treads is smoothed: flat tread, soft step, flat tread.
    const terrace = smoothstep(15, 40, h) * (1 - smoothstep(58, 78, h));
    const S = 8;
    const tf = h / S;
    const ti = Math.floor(tf);
    const terraced = (ti + smoothstep(0.32, 0.68, tf - ti)) * S;
    h = h + (terraced - h) * terrace * 0.42;

    // Rivers: a broad channel following an inverted ridge field, tapering out
    // as it climbs so it never trenches through a mountain.
    const riverField = 1 - Math.abs(n.fbm2(nx * 1.7 + 300, nz * 1.7 - 220, 3));
    const river = smoothstep(0.855, 1.0, riverField);
    const canCarve = 1 - smoothstep(18, 40, h);
    // Squared profile gives a wide shallow bed with a deeper thread mid-channel.
    h -= (river * 0.45 + river * river * 0.55) * 7.0 * canCarve * smoothstep(0.05, 0.45, mask);

    h = h * mask - (1 - mask) * 18;
    return h;
  }

  moistureRaw(x, z) {
    const s = 1 / this.size;
    const m = this.moistNoise.fbm2(x * s * 3.4 + 7, z * s * 3.4 - 3, 4) * 0.5 + 0.5;
    // Low ground is wetter; high ground dries out.
    return clamp(m, 0, 1);
  }

  /** Fill the sample grid. Cost is O(dim^2) and happens once per match. */
  bake() {
    const { dim, step, half } = this;
    let maxH = 0;
    for (let j = 0; j < dim; j++) {
      const z = -half + j * step;
      for (let i = 0; i < dim; i++) {
        const x = -half + i * step;
        const h = this.sampleRaw(x, z);
        this.height[j * dim + i] = h;
        if (h > maxH) maxH = h;
        this.moisture[j * dim + i] = this.moistureRaw(x, z);
      }
    }
    this.maxHeight = maxH;
    return this;
  }

  /**
   * Flatten a circular pad to `targetY`, feathering out to `radius`.
   * Called during world construction to seat POI buildings on level ground.
   */
  flatten(cx, cz, radius, feather = 12, targetY = null) {
    const { dim, step, half } = this;
    const y = targetY !== null ? targetY : this.heightAt(cx, cz);
    const i0 = Math.max(0, Math.floor((cx - radius - feather + half) / step));
    const i1 = Math.min(dim - 1, Math.ceil((cx + radius + feather + half) / step));
    const j0 = Math.max(0, Math.floor((cz - radius - feather + half) / step));
    const j1 = Math.min(dim - 1, Math.ceil((cz + radius + feather + half) / step));
    for (let j = j0; j <= j1; j++) {
      const z = -half + j * step;
      for (let i = i0; i <= i1; i++) {
        const x = -half + i * step;
        const d = Math.hypot(x - cx, z - cz);
        if (d > radius + feather) continue;
        const t = d <= radius ? 1 : 1 - smoothstep(radius, radius + feather, d);
        const k = j * dim + i;
        this.height[k] = this.height[k] + (y - this.height[k]) * t;
      }
    }
    this._pads.push({ x: cx, z: cz, radius, y });
    return y;
  }

  get pads() { return this._pads; }

  inside(x, z) { return x > -this.half && x < this.half && z > -this.half && z < this.half; }

  /** Bilinear elevation lookup. Clamped at the edges rather than wrapping. */
  heightAt(x, z) {
    const { dim, step, half } = this;
    let fx = (x + half) / step, fz = (z + half) / step;
    fx = fx < 0 ? 0 : fx > dim - 1.001 ? dim - 1.001 : fx;
    fz = fz < 0 ? 0 : fz > dim - 1.001 ? dim - 1.001 : fz;
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const h = this.height;
    const a = h[j * dim + i], b = h[j * dim + i + 1];
    const c = h[(j + 1) * dim + i], d = h[(j + 1) * dim + i + 1];
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
  }

  moistureAt(x, z) {
    const { dim, step, half } = this;
    let fx = (x + half) / step, fz = (z + half) / step;
    fx = fx < 0 ? 0 : fx > dim - 1.001 ? dim - 1.001 : fx;
    fz = fz < 0 ? 0 : fz > dim - 1.001 ? dim - 1.001 : fz;
    const i = fx | 0, j = fz | 0;
    return this.moisture[j * dim + i];
  }

  /** Surface normal via central differences on the baked grid. */
  normalAt(x, z, out) {
    const e = this.step;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    let nx = hl - hr, ny = 2 * e, nz = hd - hu;
    const inv = 1 / Math.hypot(nx, ny, nz);
    nx *= inv; ny *= inv; nz *= inv;
    if (out) { out.set(nx, ny, nz); return out; }
    return { x: nx, y: ny, z: nz };
  }

  /** Vertical component of the normal — cheap slope test for gameplay code. */
  slopeAt(x, z) {
    const e = this.step;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    const nx = hl - hr, ny = 2 * e, nz = hd - hu;
    return ny / Math.hypot(nx, ny, nz);
  }

  biomeAt(x, z) {
    return classify(this.heightAt(x, z), this.moistureAt(x, z), this.slopeAt(x, z));
  }

  isWater(x, z) { return this.heightAt(x, z) < SEA_LEVEL; }

  /** Find a spawnable point near (x,z): on land, not too steep, not in water. */
  findGround(x, z, rng, tries = 24, minSlope = 0.72) {
    for (let i = 0; i < tries; i++) {
      const r = i === 0 ? 0 : rng.range(4, 60);
      const a = rng.range(0, Math.PI * 2);
      const px = clamp(x + Math.cos(a) * r, -this.half + 24, this.half - 24);
      const pz = clamp(z + Math.sin(a) * r, -this.half + 24, this.half - 24);
      const h = this.heightAt(px, pz);
      if (h > SEA_LEVEL + 1.2 && this.slopeAt(px, pz) > minSlope) return { x: px, y: h, z: pz };
    }
    return { x, y: this.heightAt(x, z), z };
  }
}
