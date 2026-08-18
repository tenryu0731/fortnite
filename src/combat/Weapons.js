/**
 * Weapons — the weapon definition table.
 *
 * Numbers are tuned to the genre's feel rather than to realism: time-to-kill
 * against a 100 health + 100 shield target sits between roughly 1.5 and 3
 * seconds for every class, so no single weapon dominates, and each class wins
 * at a different range.
 *
 * `spread` is a cone half-angle in radians. `bloom` is how much sustained fire
 * widens it, `bloomDecay` how fast it recovers. `recoil` is a repeating pattern
 * of per-shot camera kicks in radians (pitch, yaw); patterns are what make a
 * weapon learnable instead of random.
 */

export const RARITY = {
  common: { key: 'common', mult: 1.00, color: 0x9aa7b4, label: 'Common' },
  uncommon: { key: 'uncommon', mult: 1.05, color: 0x58c94b, label: 'Uncommon' },
  rare: { key: 'rare', mult: 1.11, color: 0x4aa3ff, label: 'Rare' },
  epic: { key: 'epic', mult: 1.17, color: 0xb464ff, label: 'Epic' },
  legendary: { key: 'legendary', mult: 1.24, color: 0xffa22e, label: 'Legendary' },
};
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const AMMO = { light: 'light', medium: 'medium', shells: 'shells', heavy: 'heavy' };

export const WEAPONS = {
  pickaxe: {
    id: 'pickaxe', name: 'Pickaxe', class: 'melee', slotFixed: 0,
    damage: 20, headshot: 1.0, fireRate: 1.4, range: 3.2,
    magSize: Infinity, reloadTime: 0, ammo: null,
    spread: 0, bloom: 0, bloomDecay: 1, pellets: 1,
    recoil: [[0, 0]], adsFov: null, structureMult: 3.0, harvestPower: 34,
    falloffStart: 3.2, falloffEnd: 3.2, falloffMin: 1,
    sound: 'harvest',
  },
  ar: {
    id: 'ar', name: 'Assault Rifle', class: 'rifle',
    damage: 32, headshot: 1.5, fireRate: 5.5, range: 260,
    magSize: 30, reloadTime: 2.3, ammo: AMMO.medium,
    spread: 0.006, bloom: 0.0085, bloomDecay: 4.2, pellets: 1,
    recoil: [[0.011, 0.000], [0.013, -0.004], [0.012, 0.005], [0.014, -0.006],
      [0.012, 0.007], [0.010, -0.008], [0.011, 0.006], [0.009, -0.003]],
    adsFov: 46, structureMult: 0.55, harvestPower: 4,
    falloffStart: 60, falloffEnd: 190, falloffMin: 0.62,
    sound: 'shot_ar',
  },
  smg: {
    id: 'smg', name: 'SMG', class: 'smg',
    damage: 17, headshot: 1.4, fireRate: 11, range: 150,
    magSize: 30, reloadTime: 2.1, ammo: AMMO.light,
    spread: 0.010, bloom: 0.011, bloomDecay: 5.0, pellets: 1,
    recoil: [[0.007, 0.004], [0.008, -0.005], [0.007, 0.006], [0.008, -0.004],
      [0.006, 0.005], [0.007, -0.006]],
    adsFov: 54, structureMult: 0.5, harvestPower: 3,
    falloffStart: 26, falloffEnd: 90, falloffMin: 0.45,
    sound: 'shot_smg',
  },
  shotgun: {
    id: 'shotgun', name: 'Pump Shotgun', class: 'shotgun',
    damage: 10.5, headshot: 1.6, fireRate: 0.72, range: 42, pellets: 10,
    magSize: 5, reloadTime: 4.4, ammo: AMMO.shells,
    spread: 0.052, bloom: 0, bloomDecay: 1,
    recoil: [[0.045, 0.006], [0.043, -0.007]],
    adsFov: 60, structureMult: 0.85, harvestPower: 5,
    falloffStart: 8, falloffEnd: 26, falloffMin: 0.18,
    sound: 'shot_shotgun',
  },
  sniper: {
    id: 'sniper', name: 'Bolt-Action Sniper', class: 'sniper',
    damage: 105, headshot: 2.5, fireRate: 0.36, range: 600,
    magSize: 1, reloadTime: 2.9, ammo: AMMO.heavy,
    spread: 0.0016, bloom: 0.02, bloomDecay: 2.0, pellets: 1,
    recoil: [[0.075, 0.004]],
    adsFov: 22, structureMult: 1.6, harvestPower: 8,
    falloffStart: 600, falloffEnd: 600, falloffMin: 1,
    // Bullet travel is slow enough to need leading at range, which is what
    // makes sniping a skill rather than a hitscan click.
    projectileSpeed: 220, gravity: -1.6,
    sound: 'shot_sniper',
  },
  pistol: {
    id: 'pistol', name: 'Pistol', class: 'pistol',
    damage: 24, headshot: 1.5, fireRate: 6.75, range: 180,
    magSize: 16, reloadTime: 1.4, ammo: AMMO.light,
    spread: 0.007, bloom: 0.010, bloomDecay: 5.5, pellets: 1,
    recoil: [[0.013, -0.003], [0.014, 0.004], [0.012, -0.005]],
    adsFov: 52, structureMult: 0.5, harvestPower: 3,
    falloffStart: 34, falloffEnd: 110, falloffMin: 0.5,
    sound: 'shot_pistol',
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS).filter((k) => k !== 'pickaxe');

/** Loot table weights per rarity tier, by weapon id. */
export const LOOT_WEIGHTS = {
  ar: 1.0, smg: 1.0, shotgun: 0.9, pistol: 0.9, sniper: 0.35,
};

export const RARITY_WEIGHTS = { common: 0.42, uncommon: 0.29, rare: 0.18, epic: 0.083, legendary: 0.027 };

/** Reserve ammo a weapon comes with when picked up. */
export const STARTING_AMMO = { light: 120, medium: 90, shells: 24, heavy: 12 };

/**
 * A concrete weapon instance: a definition plus rarity and current magazine.
 * Kept as a plain object so it can be serialised into test snapshots.
 */
export function makeWeapon(id, rarityKey = 'common') {
  const def = WEAPONS[id];
  if (!def) throw new Error(`Unknown weapon "${id}"`);
  const rarity = RARITY[rarityKey] || RARITY.common;
  return {
    id, def, rarity: rarity.key,
    damage: def.damage * rarity.mult,
    fireRate: def.fireRate,
    magSize: def.magSize,
    ammo: def.magSize === Infinity ? Infinity : def.magSize,
    reloadTimer: 0,
    cooldown: 0,
    shotIndex: 0,
    bloom: 0,
  };
}

/** Damage after distance falloff. */
export function falloff(def, distance) {
  if (distance <= def.falloffStart) return 1;
  if (distance >= def.falloffEnd) return def.falloffMin;
  const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return 1 + (def.falloffMin - 1) * t;
}

/** Body-part damage multiplier from the fraction of body height that was hit. */
export function partMultiplier(def, heightFraction) {
  if (heightFraction > 0.82) return { mult: def.headshot, part: 'head' };
  if (heightFraction < 0.35) return { mult: 0.85, part: 'legs' };
  return { mult: 1.0, part: 'body' };
}
