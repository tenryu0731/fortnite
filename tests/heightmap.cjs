/**
 * heightmap.cjs — offline hillshade + slope statistics for the height field.
 * Renders without a browser so terrain shape can be iterated in a second.
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { OUT } = require('./harness.cjs');

(async () => {
  const { HeightField } = await import('../src/world/HeightField.js');
  const { classify, SEA_LEVEL } = await import('../src/world/Biome.js');
  const seed = Number(process.argv[2] || 1337);
  const t0 = Date.now();
  const f = new HeightField(seed, { size: 1024, step: 2 }).bake();
  const bakeMs = Date.now() - t0;

  const W = 512, H = 512;
  const png = new PNG({ width: W, height: H });
  const BIOME_COL = [[40,70,90],[205,186,132],[92,133,61],[61,102,51],[118,112,107],[235,240,247],[112,87,56]];
  let maxH = -1e9, minH = 1e9;
  const slopes = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const wx = (x / W - 0.5) * 1024, wz = (y / H - 0.5) * 1024;
      const h = f.heightAt(wx, wz);
      const slope = f.slopeAt(wx, wz);
      if (h > maxH) maxH = h; if (h < minH) minH = h;
      if (h > SEA_LEVEL) slopes.push(slope);
      const b = classify(h, f.moistureAt(wx, wz), slope);
      // Lambert hillshade from a fixed north-west sun.
      const n = f.normalAt(wx, wz);
      const lit = Math.max(0.18, n.x * -0.45 + n.y * 0.78 + n.z * -0.44);
      const c = BIOME_COL[b];
      const i = (y * W + x) * 4;
      png.data[i] = Math.min(255, c[0] * lit * 1.5);
      png.data[i+1] = Math.min(255, c[1] * lit * 1.5);
      png.data[i+2] = Math.min(255, c[2] * lit * 1.5);
      png.data[i+3] = 255;
    }
  }
  fs.writeFileSync(path.join(OUT, 'heightmap.png'), PNG.sync.write(png));

  slopes.sort((a, b) => a - b);
  const q = (p) => slopes[Math.floor(p * (slopes.length - 1))].toFixed(3);
  // Land fraction and how much of it is walkable (slope > 0.72 ~ under 44deg).
  let land = 0, walk = 0, water = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = (x / W - 0.5) * 1024, wz = (y / H - 0.5) * 1024;
    const h = f.heightAt(wx, wz);
    if (h > SEA_LEVEL) { land++; if (f.slopeAt(wx, wz) > 0.72) walk++; } else water++;
  }
  console.log(JSON.stringify({
    seed, bakeMs,
    height: { min: +minH.toFixed(1), max: +maxH.toFixed(1) },
    slope: { p05: +q(0.05), p25: +q(0.25), p50: +q(0.5), p75: +q(0.75), p95: +q(0.95) },
    landPct: +(land / (W * H) * 100).toFixed(1),
    walkablePctOfLand: +(walk / Math.max(1, land) * 100).toFixed(1),
  }));
})();
