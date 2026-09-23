/**
 * stylemetrics.cjs — measure the look of a frame in numbers.
 *
 * The art direction target is "reads like the genre it belongs to": high-key,
 * saturated, soft-shadowed, with a pale hazy sky and yellow-green grass. That
 * is a statement about colour statistics, so it can be measured and gated like
 * any other budget instead of argued about.
 *
 * Every metric is computed in CIE Lab (D65) over a crop that excludes the HUD,
 * after decoding sRGB properly — averaging gamma-encoded values would put the
 * midpoint of every comparison in the wrong place.
 *
 *   L        mean / std / 5th / 95th percentile lightness (0-100)
 *   chroma   mean C*ab, and Hasler-Süsstrunk colourfulness (RGB space)
 *   sky      mean Lab of sky-classified pixels, and their coverage
 *   grass    mean Lab and hue angle of foliage-classified pixels
 *   shadow   mean chroma of the darkest decile — the genre's shadows are
 *            tinted, never black, and this is the number that says so
 *
 * Reference screenshots are copyrighted and are never committed. Their
 * statistics are: tests/style-targets.json holds only the derived numbers.
 */
const fs = require('fs');
const { PNG } = require('pngjs');

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LUT = new Float64Array(256);
for (let i = 0; i < 256; i++) LUT[i] = srgbToLinear(i);

function labOf(r, g, b) {
  const R = LUT[r], G = LUT[g], B = LUT[b];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function pct(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/**
 * crop = { x0, x1, y0, y1 } as fractions of the frame. `exclude` is a list of
 * further rectangles (same units) to drop, for HUD elements inside the crop.
 */
function measure(png, crop = { x0: 0, x1: 1, y0: 0, y1: 1 }, exclude = []) {
  const { width: W, height: H, data } = png;
  const X0 = Math.floor(crop.x0 * W), X1 = Math.floor(crop.x1 * W);
  const Y0 = Math.floor(crop.y0 * H), Y1 = Math.floor(crop.y1 * H);
  const Ls = [];
  let sumL = 0, sumL2 = 0, sumC = 0, n = 0;
  let rgSum = 0, rgSq = 0, ybSum = 0, ybSq = 0;
  const sky = { L: 0, a: 0, b: 0, n: 0 };
  const grass = { L: 0, a: 0, b: 0, n: 0, hx: 0, hy: 0 };
  const pix = [];
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const fx = x / W, fy = y / H;
      if (exclude.some((e) => fx >= e.x0 && fx < e.x1 && fy >= e.y0 && fy < e.y1)) continue;
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [L, A, Bb] = labOf(r, g, b);
      const C = Math.hypot(A, Bb);
      Ls.push(L);
      pix.push(L, C);
      sumL += L; sumL2 += L * L; sumC += C; n++;
      const rg = r - g, yb = 0.5 * (r + g) - b;
      rgSum += rg; rgSq += rg * rg; ybSum += yb; ybSq += yb * yb;
      // Sky: bright and blue-leaning. Clouds (bright, neutral) count too,
      // because a genre sky is as much cloud as it is blue.
      if (L > 58 && Bb < -4 && Bb < -Math.abs(A) * 0.5) { sky.L += L; sky.a += A; sky.b += Bb; sky.n++; }
      // Foliage: clearly green, not grey.
      if (A < -8 && C > 14 && L > 12) {
        grass.L += L; grass.a += A; grass.b += Bb; grass.n++;
        const h = Math.atan2(Bb, A);
        grass.hx += Math.cos(h); grass.hy += Math.sin(h);
      }
    }
  }
  Ls.sort((p, q) => p - q);
  const meanL = sumL / n;
  const stdL = Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL));
  const rgM = rgSum / n, ybM = ybSum / n;
  const rgS = Math.sqrt(Math.max(0, rgSq / n - rgM * rgM));
  const ybS = Math.sqrt(Math.max(0, ybSq / n - ybM * ybM));
  const colourfulness = Math.hypot(rgS, ybS) + 0.3 * Math.hypot(rgM, ybM);

  // Shadow tint: chroma of the darkest 10% of pixels.
  const p10 = pct(Ls, 0.10);
  let shC = 0, shN = 0;
  for (let k = 0; k < pix.length; k += 2) if (pix[k] <= p10) { shC += pix[k + 1]; shN++; }

  const avg = (o) => (o.n ? { L: o.L / o.n, a: o.a / o.n, b: o.b / o.n } : { L: 0, a: 0, b: 0 });
  const g = avg(grass);
  let hue = grass.n ? Math.atan2(grass.hy, grass.hx) * 180 / Math.PI : 0;
  if (hue < 0) hue += 360;
  return {
    L: { mean: meanL, std: stdL, p05: pct(Ls, 0.05), p95: pct(Ls, 0.95) },
    chroma: sumC / n,
    colourfulness,
    shadowChroma: shN ? shC / shN : 0,
    sky: { ...avg(sky), coverage: sky.n / n },
    grass: { ...g, hue, coverage: grass.n / n },
  };
}

function load(file) { return PNG.sync.read(fs.readFileSync(file)); }

function fmtMetrics(m) {
  const r = (v, d = 1) => (+v).toFixed(d);
  return `L ${r(m.L.mean)}±${r(m.L.std)} [p05 ${r(m.L.p05)} p95 ${r(m.L.p95)}]  chroma ${r(m.chroma)}  colourful ${r(m.colourfulness)}  shadowC ${r(m.shadowChroma)}\n`
    + `      sky L${r(m.sky.L)} a${r(m.sky.a)} b${r(m.sky.b)} (${r(m.sky.coverage * 100)}%)`
    + `  grass L${r(m.grass.L)} a${r(m.grass.a)} b${r(m.grass.b)} hue ${r(m.grass.hue)}° (${r(m.grass.coverage * 100)}%)`;
}

module.exports = { measure, load, labOf, fmtMetrics };

if (require.main === module) {
  const [file, crop] = process.argv.slice(2);
  const c = crop ? JSON.parse(crop) : undefined;
  console.log(fmtMetrics(measure(load(file), c)));
}
