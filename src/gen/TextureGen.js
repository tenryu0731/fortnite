import * as THREE from 'three';
import { Noise, clamp, smoothstep } from './Noise.js';
import { Rng } from './Rng.js';

/**
 * TextureGen — Canvas2D procedural texture synthesis.
 *
 * Every generator writes both an albedo byte buffer and a scalar height field
 * in one pass; the height field is then Sobel-differentiated into a tangent
 * space normal map. All lattice noise is sampled through `fbmTile`/`perlin2Tile`
 * with a period equal to the texture's feature grid, so the results tile
 * seamlessly in both axes (verified by tests/unit.cjs).
 *
 * Results are cached by key so repeated requests share one GPU upload.
 */

function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Sobel height -> tangent-space normal, packed into an RGB byte buffer. */
function normalFromHeight(height, size, strength, out) {
  const idx = (x, y) => ((y & (size - 1)) * size + (x & (size - 1)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = height[idx(x - 1, y - 1)], t = height[idx(x, y - 1)], tr = height[idx(x + 1, y - 1)];
      const l = height[idx(x - 1, y)], r = height[idx(x + 1, y)];
      const bl = height[idx(x - 1, y + 1)], b = height[idx(x, y + 1)], br = height[idx(x + 1, y + 1)];
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (y * size + x) * 4;
      out[o] = (nx * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * 0.5 + 0.5) * 255;
      out[o + 2] = nz * 255;
      out[o + 3] = 255;
    }
  }
}

function toTexture(buf, size, { srgb = true, repeat = 1, aniso = 4 } = {}) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const SURFACES = {
  /* --- ground --------------------------------------------------------- */
  /**
   * Near-white luminance detail for the terrain. Terrain colour comes from
   * per-vertex biome blending, so this map only supplies grain and breakup;
   * keeping it desaturated lets one texture serve sand, grass, rock and snow.
   */
  ground(n, u, v) {
    const macro = n.fbmTile(u * 6, v * 6, 6, 6, 3) * 0.5 + 0.5;
    const grain = n.fbmTile(u * 42, v * 42, 42, 42, 2) * 0.5 + 0.5;
    const speck = smoothstep(0.88, 1.0, 1 - n.worley2(u * 20, v * 20, 20));
    const l = 176 + macro * 44 + grain * 30 - speck * 30;
    return [l, l * 0.995, l * 0.985, macro * 0.5 + grain * 0.35 + speck * 0.15];
  },

  grass(n, u, v, s, rng) {
    // Broad tonal variation plus fine blade-scale streaks.
    const macro = n.fbmTile(u * 4, v * 4, 4, 4, 4) * 0.5 + 0.5;
    const blades = n.fbmTile(u * 40, v * 40, 40, 40, 2) * 0.5 + 0.5;
    const clump = n.worley2(u * 9, v * 9, 9);
    const dry = smoothstep(0.35, 0.85, macro);
    let r = 58 + dry * 52 + blades * 26;
    let g = 96 + dry * 40 + blades * 30;
    let b = 42 + dry * 20 + blades * 14;
    const dirt = smoothstep(0.72, 0.95, 1 - clump);
    r = r * (1 - dirt) + 104 * dirt;
    g = g * (1 - dirt) + 84 * dirt;
    b = b * (1 - dirt) + 56 * dirt;
    return [r, g, b, blades * 0.55 + macro * 0.45];
  },

  dirt(n, u, v) {
    const macro = n.fbmTile(u * 5, v * 5, 5, 5, 4) * 0.5 + 0.5;
    const grit = n.fbmTile(u * 48, v * 48, 48, 48, 2) * 0.5 + 0.5;
    const pebble = smoothstep(0.86, 1.0, 1 - n.worley2(u * 22, v * 22, 22));
    let r = 96 + macro * 44 + grit * 22;
    let g = 74 + macro * 34 + grit * 18;
    let b = 52 + macro * 22 + grit * 14;
    r += pebble * 40; g += pebble * 36; b += pebble * 30;
    return [r, g, b, grit * 0.4 + macro * 0.3 + pebble * 0.3];
  },

  sand(n, u, v) {
    const dune = n.fbmTile(u * 3, v * 3, 3, 3, 3) * 0.5 + 0.5;
    const ripple = Math.sin((u * 30 + n.fbmTile(u * 4, v * 4, 4, 4, 2) * 3) * Math.PI * 2) * 0.5 + 0.5;
    const grain = n.perlin2Tile(u * 88, v * 88, 88, 88) * 0.5 + 0.5;
    const h = dune * 0.5 + ripple * 0.3 + grain * 0.2;
    return [198 + h * 40, 176 + h * 38, 132 + h * 34, h];
  },

  rock(n, u, v) {
    const strata = n.fbmTile(u * 6, v * 6, 6, 6, 4) * 0.5 + 0.5;
    const crack = n.worley2(u * 7, v * 7, 7);
    const grain = n.fbmTile(u * 60, v * 60, 60, 60, 2) * 0.5 + 0.5;
    const crackMask = smoothstep(0.0, 0.13, crack);
    let base = 92 + strata * 58 + grain * 20;
    base *= 0.55 + crackMask * 0.45;
    const warm = strata * 14;
    return [base + warm, base + warm * 0.6, base * 0.94, strata * 0.6 + grain * 0.2 + crackMask * 0.2];
  },

  gravel(n, u, v) {
    const cell = n.worley2(u * 26, v * 26, 26);
    const stone = smoothstep(0.02, 0.30, cell);
    const grain = n.fbmTile(u * 70, v * 70, 70, 70, 2) * 0.5 + 0.5;
    const tone = 78 + stone * 74 + grain * 26;
    return [tone, tone * 0.98, tone * 0.94, stone * 0.8 + grain * 0.2];
  },

  /* --- built surfaces -------------------------------------------------- */
  /**
   * Neutral detail for building panels. Like `ground`, this is close to white
   * so the per-instance tint decides whether a panel reads as timber, brick,
   * concrete or steel; that is what lets every structure on the map share one
   * material and therefore one draw call per panel type.
   */
  panel(n, u, v) {
    const macro = n.fbmTile(u * 4, v * 4, 4, 4, 3) * 0.5 + 0.5;
    const grain = n.fbmTile(u * 34, v * 34, 34, 34, 2) * 0.5 + 0.5;
    const streak = n.perlin2Tile(u * 3, v * 26, 3, 26) * 0.5 + 0.5;
    const wear = smoothstep(0.72, 1.0, 1 - n.worley2(u * 7, v * 7, 7));
    const l = 188 + macro * 34 + grain * 22 + streak * 14 - wear * 44;
    return [l, l * 0.995, l * 0.985, macro * 0.4 + grain * 0.35 + wear * 0.25];
  },

  plank(n, u, v) {
    // 6 horizontal boards with per-board tint offset and lengthwise grain.
    const boards = 6;
    const by = v * boards;
    const bi = Math.floor(by);
    const bf = by - bi;
    // Index is wrapped into the board period so the texture tiles vertically.
    const bw = ((bi % boards) + boards) % boards;
    const tint = ((bw * 2654435761) % 1000) / 1000;
    const grain = n.fbmTile(u * 70, (v + tint * 5) * 8, 70, 8, 2) * 0.5 + 0.5;
    const knot = smoothstep(0.92, 1.0, 1 - n.worley2(u * 5 + tint * 3, bw * 0.9, 5));
    const gap = smoothstep(0.0, 0.045, bf) * smoothstep(0.0, 0.045, 1 - bf);
    const nails = smoothstep(0.985, 1.0, Math.max(smoothstep(0.0, 0.02, 0.02 - Math.abs(u - 0.06)), smoothstep(0.0, 0.02, 0.02 - Math.abs(u - 0.94))) * (bf > 0.35 && bf < 0.65 ? 1 : 0));
    let r = 150 + tint * 40 + grain * 44;
    let g = 108 + tint * 30 + grain * 36;
    let b = 68 + tint * 18 + grain * 24;
    r *= 1 - knot * 0.45; g *= 1 - knot * 0.5; b *= 1 - knot * 0.5;
    r *= 0.45 + gap * 0.55; g *= 0.45 + gap * 0.55; b *= 0.45 + gap * 0.55;
    r += nails * 60; g += nails * 60; b += nails * 60;
    return [r, g, b, gap * (0.5 + grain * 0.35) + nails * 0.15];
  },

  bark(n, u, v) {
    const ridge = n.ridgedTile(u * 8, v * 2, 8, 2, 4);
    const fibre = n.fbmTile(u * 26, v * 6, 26, 6, 3) * 0.5 + 0.5;
    const h = ridge * 0.7 + fibre * 0.3;
    const tone = 58 + h * 62;
    return [tone * 1.12, tone * 0.92, tone * 0.72, h];
  },

  brick(n, u, v) {
    // Running bond: 8 courses, half-brick offset on odd rows.
    const rows = 8, cols = 4;
    const ry = v * rows;
    const ri = Math.floor(ry);
    const rf = ry - ri;
    const off = (ri & 1) ? 0.5 : 0;
    const rx = (u + off) * cols;
    const ci = Math.floor(rx);
    const cf = rx - ci;
    const mortarV = smoothstep(0, 0.10, rf) * smoothstep(0, 0.10, 1 - rf);
    const mortarH = smoothstep(0, 0.05, cf) * smoothstep(0, 0.05, 1 - cf);
    const mortar = Math.min(mortarV, mortarH);
    // Wrap course/column indices into their periods so the pattern tiles.
    const rw = ((ri % rows) + rows) % rows, cw = ((ci % cols) + cols) % cols;
    const seed = ((rw * 73856093) ^ (cw * 19349663)) >>> 0;
    const tint = (seed % 1000) / 1000;
    const grit = n.fbmTile(u * 80, v * 80, 80, 80, 2) * 0.5 + 0.5;
    let r = 138 + tint * 52 + grit * 22;
    let g = 68 + tint * 26 + grit * 18;
    let b = 54 + tint * 18 + grit * 16;
    const mr = 168 + grit * 24;
    r = r * mortar + mr * (1 - mortar);
    g = g * mortar + mr * (1 - mortar);
    b = b * mortar + (mr - 6) * (1 - mortar);
    return [r, g, b, mortar * 0.8 + grit * 0.2];
  },

  concrete(n, u, v) {
    const blotch = n.fbmTile(u * 6, v * 6, 6, 6, 4) * 0.5 + 0.5;
    const grit = n.perlin2Tile(u * 96, v * 96, 96, 96) * 0.5 + 0.5;
    const pit = smoothstep(0.9, 1.0, 1 - n.worley2(u * 30, v * 30, 30));
    const stain = smoothstep(0.55, 0.95, n.fbmTile(u * 2 + 10, v * 2, 2, 2, 3) * 0.5 + 0.5);
    let tone = 136 + blotch * 40 + grit * 18 - pit * 34 - stain * 26;
    return [tone, tone * 0.99, tone * 0.96, blotch * 0.5 + grit * 0.2 + (1 - pit) * 0.3];
  },

  metal(n, u, v) {
    // Brushed sheet divided into 4x4 panels, each with a rivet at its centre.
    const brush = n.perlin2Tile(u * 120, v * 6, 120, 6) * 0.5 + 0.5;
    const panel = n.fbmTile(u * 3, v * 3, 3, 3, 3) * 0.5 + 0.5;
    // Distance from the centre of the enclosing panel cell, in cell units.
    const cx = Math.abs(((u * 4) % 1) - 0.5), cy = Math.abs(((v * 4) % 1) - 0.5);
    const dCentre = Math.hypot(cx, cy);
    const rivet = smoothstep(0.075, 0.035, dCentre);
    const rivetShade = smoothstep(0.035, 0.075, dCentre) * smoothstep(0.10, 0.075, dCentre);
    const seam = smoothstep(0.47, 0.5, Math.max(cx, cy));
    const rust = smoothstep(0.62, 0.95, n.fbmTile(u * 8 + 5, v * 8, 8, 8, 4) * 0.5 + 0.5);
    let tone = 132 + panel * 22 + brush * 26;
    let r = tone, g = tone * 1.01, b = tone * 1.06;
    r = r * (1 - rust) + 126 * rust;
    g = g * (1 - rust) + 72 * rust;
    b = b * (1 - rust) + 44 * rust;
    const lift = rivet * 46 - rivetShade * 26 - seam * 34;
    return [r + lift, g + lift, b + lift, brush * 0.25 + panel * 0.2 + rivet * 0.45 - seam * 0.3];
  },

  shingle(n, u, v) {
    const rows = 10, cols = 6;
    const ry = v * rows, ri = Math.floor(ry), rf = ry - ri;
    const off = (ri & 1) ? 0.5 : 0;
    const rx = (u + off) * cols, ci = Math.floor(rx), cf = rx - ci;
    const rw = ((ri % rows) + rows) % rows, cw = ((ci % cols) + cols) % cols;
    const seed = ((rw * 40499) ^ (cw * 86969)) >>> 0;
    const tint = (seed % 997) / 997;
    const edge = smoothstep(0, 0.08, rf) * smoothstep(0, 0.06, cf) * smoothstep(0, 0.06, 1 - cf);
    const grit = n.perlin2Tile(u * 88, v * 88, 88, 88) * 0.5 + 0.5;
    const weather = n.fbmTile(u * 5, v * 5, 5, 5, 3) * 0.5 + 0.5;
    const base = 74 + tint * 38 + grit * 14 + weather * 20;
    const shade = 0.55 + edge * 0.45;
    return [base * 1.06 * shade, base * 0.95 * shade, base * 0.88 * shade, edge * 0.7 + grit * 0.3];
  },

  fabric(n, u, v) {
    const weave = (Math.sin(u * Math.PI * 2 * 64) * Math.sin(v * Math.PI * 2 * 64)) * 0.5 + 0.5;
    const macro = n.fbmTile(u * 5, v * 5, 5, 5, 3) * 0.5 + 0.5;
    const tone = 70 + macro * 40 + weave * 20;
    return [tone * 0.9, tone * 1.0, tone * 1.18, weave * 0.6 + macro * 0.4];
  },

  /* --- special --------------------------------------------------------- */
  storm(n, u, v) {
    const swirl = n.fbmTile(u * 6, v * 3, 6, 3, 5) * 0.5 + 0.5;
    const fine = n.fbmTile(u * 20, v * 10, 20, 10, 3) * 0.5 + 0.5;
    const h = swirl * 0.7 + fine * 0.3;
    return [120 + h * 110, 60 + h * 90, 220 + h * 35, h];
  },
};

/** Alpha-cut foliage card: a cluster of leaf shapes drawn with Canvas2D paths. */
function makeLeafTexture(size, seed) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = new Rng(seed);
  const leaves = 26;
  for (let i = 0; i < leaves; i++) {
    const cx = rng.range(0.12, 0.88) * size;
    const cy = rng.range(0.12, 0.88) * size;
    const len = rng.range(0.10, 0.24) * size;
    const wid = len * rng.range(0.38, 0.62);
    const ang = rng.range(0, Math.PI * 2);
    const shade = rng.range(0.62, 1.0);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    const g = ctx.createLinearGradient(-len, 0, len, 0);
    const r0 = Math.floor(46 * shade), g0 = Math.floor(112 * shade), b0 = Math.floor(38 * shade);
    g.addColorStop(0, `rgb(${r0},${g0},${b0})`);
    g.addColorStop(1, `rgb(${Math.floor(r0 * 1.5)},${Math.floor(g0 * 1.35)},${Math.floor(b0 * 1.3)})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.quadraticCurveTo(0, -wid, len, 0);
    ctx.quadraticCurveTo(0, wid, -len, 0);
    ctx.fill();
    ctx.strokeStyle = `rgba(${r0 * 0.6},${g0 * 0.7},${b0 * 0.6},0.7)`;
    ctx.lineWidth = Math.max(1, size / 220);
    ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(len, 0); ctx.stroke();
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Bullet-hole decal: a soft dark core with a lighter rim and irregular edge,
 * drawn with alpha so it can be laid over any surface.
 */
function makeDecalTexture(size, seed) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = new Rng(seed);
  const c = size / 2;

  // Rim: a slightly ragged lighter ring reads as blown-out material.
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = size * (0.30 + rng.range(-0.05, 0.05));
    const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(210,205,196,0.55)';
  ctx.fill();

  // Core: a dark hole with a soft falloff.
  const g = ctx.createRadialGradient(c, c, 0, c, c, size * 0.26);
  g.addColorStop(0, 'rgba(14,12,10,0.96)');
  g.addColorStop(0.55, 'rgba(24,20,17,0.80)');
  g.addColorStop(1, 'rgba(30,26,22,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.30, 0, Math.PI * 2);
  ctx.fill();

  // Radial cracks.
  ctx.strokeStyle = 'rgba(20,17,14,0.5)';
  ctx.lineWidth = Math.max(1, size / 90);
  for (let i = 0; i < 7; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r0 = size * 0.22, r1 = size * rng.range(0.30, 0.46);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Soft radial sprite used for sparks, flashes and dust. One texture serves all
 * of them; colour and size come from the particle, not the image.
 */
function makeSparkTexture(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.28, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.20)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Vertical sky gradient strip with a subtle horizon haze band. */
function makeSkyTexture(size, top, horizon, bottom) {
  const canvas = createCanvas(4, size);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, top);
  g.addColorStop(0.46, horizon);
  g.addColorStop(0.52, horizon);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export class TextureGen {
  constructor(seed = 1, size = 256) {
    this.noise = new Noise(seed ^ 0x9e3779b9);
    this.size = size;
    this.cache = new Map();
    this.stats = { generated: 0, pixels: 0 };
  }

  /** Raw byte buffers for a named surface — exposed so tests can check tiling. */
  surfaceBuffers(name, size = this.size) {
    const fn = SURFACES[name];
    if (!fn) throw new Error(`Unknown surface "${name}"`);
    const px = new Uint8ClampedArray(size * size * 4);
    const height = new Float32Array(size * size);
    const n = this.noise;
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const c = fn(n, u, v, size);
        const i = y * size + x;
        px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
        height[i] = c[3];
      }
    }
    this.stats.generated++;
    this.stats.pixels += size * size;
    return { px, height, size };
  }

  /**
   * Full material set for a surface: albedo + normal (+ optional roughness).
   * `opts.repeat` sets UV tiling, `opts.normalStrength` scales the Sobel slope.
   */
  surface(name, opts = {}) {
    const size = opts.size || this.size;
    const key = `${name}:${size}:${opts.repeat || 1}:${opts.normalStrength || 1}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const { px, height } = this.surfaceBuffers(name, size);
    const nrmBuf = new Uint8ClampedArray(size * size * 4);
    normalFromHeight(height, size, (opts.normalStrength ?? 1) * 1.6, nrmBuf);
    const out = {
      map: toTexture(px, size, { srgb: true, repeat: opts.repeat || 1 }),
      normalMap: toTexture(nrmBuf, size, { srgb: false, repeat: opts.repeat || 1 }),
    };
    this.cache.set(key, out);
    return out;
  }

  leaf(size = 256, seed = 7) {
    const key = `leaf:${size}:${seed}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const t = makeLeafTexture(size, seed);
    this.cache.set(key, t);
    return t;
  }

  sky(size = 128, top = '#3a72c4', horizon = '#bcd6ee', bottom = '#7d8b78') {
    const key = `sky:${size}:${top}:${horizon}:${bottom}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const t = makeSkyTexture(size, top, horizon, bottom);
    this.cache.set(key, t);
    return t;
  }

  /** Small solid-colour texture — handy placeholder that avoids a null map. */
  decal(size = 128, seed = 3) {
    const key = `decal:${size}:${seed}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const t = makeDecalTexture(size, seed);
    this.cache.set(key, t);
    return t;
  }

  spark(size = 64) {
    const key = `spark:${size}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const t = makeSparkTexture(size);
    this.cache.set(key, t);
    return t;
  }

  solid(hex) {
    const key = `solid:${hex}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const c = createCanvas(2, 2);
    const ctx = c.getContext('2d');
    ctx.fillStyle = hex; ctx.fillRect(0, 0, 2, 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    this.cache.set(key, t);
    return t;
  }

  dispose() {
    for (const v of this.cache.values()) {
      if (v.map) { v.map.dispose(); v.normalMap.dispose(); }
      else if (v.dispose) v.dispose();
    }
    this.cache.clear();
  }

  static surfaceNames() { return Object.keys(SURFACES); }
}

export { SURFACES, normalFromHeight };
