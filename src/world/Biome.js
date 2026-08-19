import { srgbAll } from '../gen/Palette.js';

/**
 * Biome — maps (height, moisture, slope) to surface colour and scatter density.
 *
 * Colours are baked into terrain vertex colours and multiplied against a single
 * shared ground texture, so the whole island renders with one material.
 */

export const BIOME = {
  OCEAN: 0,
  BEACH: 1,
  GRASS: 2,
  FOREST: 3,
  ROCK: 4,
  SNOW: 5,
  DIRT: 6,
};

export const BIOME_NAMES = ['ocean', 'beach', 'grass', 'forest', 'rock', 'snow', 'dirt'];

/**
 * Base albedo per biome, authored in sRGB and converted once to the linear
 * working space that a vertex-colour attribute is interpreted in.
 */
const COLORS = srgbAll([
  [0.16, 0.28, 0.36], // ocean floor
  [0.80, 0.73, 0.52], // beach sand
  [0.28, 0.44, 0.17], // grassland
  [0.19, 0.34, 0.15], // forest
  [0.46, 0.44, 0.42], // exposed rock
  [0.92, 0.94, 0.97], // snow
  [0.40, 0.31, 0.19], // dirt / path
]);

export const SEA_LEVEL = 3.0;
export const SNOW_LINE = 52.0;
export const ROCK_SLOPE = 0.62;   // cos(angle) below this is treated as cliff

/**
 * Classify a terrain sample. `slope` is the vertical component of the surface
 * normal (1 = flat, 0 = vertical wall).
 */
export function classify(height, moisture, slope) {
  if (height < SEA_LEVEL - 0.35) return BIOME.OCEAN;
  if (height < SEA_LEVEL + 1.8) return BIOME.BEACH;
  if (slope < ROCK_SLOPE) return BIOME.ROCK;
  if (height > SNOW_LINE) return BIOME.SNOW;
  if (moisture > 0.56) return BIOME.FOREST;
  if (moisture < 0.24) return BIOME.DIRT;
  return BIOME.GRASS;
}

/**
 * Blended colour for a sample. Blending across the biome boundaries avoids the
 * banded look a hard classification would give on a large open map.
 */
export function colorAt(height, moisture, slope, variation, out) {
  const b = classify(height, moisture, slope);
  const c = COLORS[b];
  let r = c[0], g = c[1], bl = c[2];

  // Soften the sand/grass boundary over a 3m band.
  if (b === BIOME.GRASS || b === BIOME.FOREST || b === BIOME.DIRT) {
    const t = Math.min(1, Math.max(0, (height - (SEA_LEVEL + 1.8)) / 3.0));
    const s = COLORS[BIOME.BEACH];
    r = s[0] + (r - s[0]) * t;
    g = s[1] + (g - s[1]) * t;
    bl = s[2] + (bl - s[2]) * t;
  }
  // Rock bleeds in as slope steepens, so cliffs are not a hard cut.
  if (b !== BIOME.ROCK && b !== BIOME.OCEAN) {
    const t = Math.min(1, Math.max(0, (ROCK_SLOPE + 0.14 - slope) / 0.14));
    const s = COLORS[BIOME.ROCK];
    r += (s[0] - r) * t; g += (s[1] - g) * t; bl += (s[2] - bl) * t;
  }
  // Snow dusts in above the snow line.
  if (height > SNOW_LINE - 8 && b !== BIOME.OCEAN) {
    const t = Math.min(1, Math.max(0, (height - (SNOW_LINE - 8)) / 10)) * Math.max(0, (slope - 0.5) / 0.5);
    const s = COLORS[BIOME.SNOW];
    r += (s[0] - r) * t; g += (s[1] - g) * t; bl += (s[2] - bl) * t;
  }

  const k = 0.80 + variation * 0.40;
  out[0] = r * k; out[1] = g * k; out[2] = bl * k;
  return b;
}

/** Scatter weights per biome: [tree, pine, rock, grass]. */
export const SCATTER = [
  [0.00, 0.00, 0.00, 0.00], // ocean
  [0.01, 0.00, 0.05, 0.06], // beach
  [0.16, 0.05, 0.10, 1.00], // grass
  [0.85, 0.45, 0.08, 0.62], // forest
  [0.01, 0.02, 0.55, 0.05], // rock
  [0.00, 0.10, 0.30, 0.02], // snow
  [0.06, 0.02, 0.18, 0.35], // dirt
];
