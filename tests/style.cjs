/**
 * style.cjs — art-direction gate.
 *
 * Measures the committed visual baselines (which the visual suite keeps equal
 * to the live render within 0.3%) with the same colour statistics that were
 * taken from reference gameplay frames, and fails if the look has drifted out
 * of the genre's range: too dark, too grey, crushed shadows, the wrong green,
 * a sky that is no longer a hazy blue.
 *
 * Only derived numbers are committed (tests/style-targets.json); the reference
 * frames are copyrighted and stay out of the repository.
 */
const path = require('path');
const { measure, load } = require('./stylemetrics.cjs');
const { check, fmt } = require('./harness.cjs');

const targets = require('./style-targets.json');

function pick(m, key) {
  return key.split('.').reduce((o, k) => o[k], { ...m, colourfulness: m.colourfulness });
}

function main() {
  console.log('\n\x1b[1mArt direction\x1b[0m (colour statistics vs reference-derived targets)');
  let ok = true;
  for (const frame of targets.frames) {
    const m = measure(load(path.join(__dirname, 'baseline', `${frame}.png`)));
    for (const [key, { target, tol }] of Object.entries(targets.metrics)) {
      const v = pick(m, key);
      ok = check(`${frame} ${key} within ${target} ± ${tol}`, Math.abs(v - target) <= tol,
        `got ${fmt(v)}`) && ok;
    }
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();
