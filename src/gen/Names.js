/**
 * Names — procedural player handles for bots.
 *
 * A kill feed reading "Bot 7 eliminated Bot 12" tells the player they are
 * alone in a lobby of scripts. Handles in the style players actually pick —
 * two words, sometimes a number or an underscore — make the same feed read as
 * a lobby. Seeded, so a match is reproducible, and checked for duplicates so
 * two opponents never share a name.
 */
const FIRST = [
  'Nova', 'Pixel', 'Shadow', 'Turbo', 'Frost', 'Lucky', 'Cosmic', 'Neon', 'Silent', 'Rapid',
  'Crimson', 'Mighty', 'Sneaky', 'Blazing', 'Echo', 'Storm', 'Hyper', 'Mystic', 'Rogue', 'Solar',
  'Vortex', 'Jelly', 'Captain', 'Lil', 'Sir', 'Iron', 'Golden', 'Chill', 'Wild', 'Quantum',
];
const SECOND = [
  'Fox', 'Raider', 'Panda', 'Llama', 'Ninja', 'Viper', 'Falcon', 'Bean', 'Knight', 'Wolf',
  'Ghost', 'Taco', 'Sniper', 'Otter', 'Comet', 'Builder', 'Hawk', 'Noodle', 'Tiger', 'Pickle',
  'Rex', 'Moth', 'Blade', 'Waffle', 'Yeti', 'Dash', 'Sprout', 'Bolt', 'Kraken', 'Muffin',
];

export function makeHandle(rng) {
  const a = rng.pick(FIRST), b = rng.pick(SECOND);
  const style = rng.next();
  if (style < 0.35) return `${a}${b}`;
  if (style < 0.65) return `${a}${b}${rng.intRange(1, 99)}`;
  if (style < 0.85) return `${a}_${b}`;
  return `x${a}${b}x`;
}

/** `count` distinct handles. */
export function makeHandles(rng, count) {
  const seen = new Set();
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 50) {
    const h = makeHandle(rng);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}
