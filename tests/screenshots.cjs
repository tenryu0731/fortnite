/**
 * screenshots.cjs — deterministic screenshot capture + baseline diffing.
 *
 * Determinism recipe: fixed seed, `__GAME.deterministic(true)` (freezes FX,
 * animation phase and adaptive resolution), a fixed camera pose per scenario,
 * a fixed number of simulation steps, then a settle render before capture.
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const { startServer, launch, openGame, OUT, BASELINE, ensureDirs, check, fmt } = require('./harness.cjs');

// Threshold from ARCHITECTURE.md 11.3.
//
// Measured noise floor: scenes made only of large flat surfaces reproduce
// bit-exactly (0.0000%), but frames containing the character, shadow-map edges
// or DOM text vary by up to ~0.08% between runs — SwiftShader's multithreaded
// rasteriser and font rasterisation are not bit-reproducible across processes.
// 0.30% keeps roughly 4x margin over that floor while still catching any real
// visual change, which always moves far more than a handful of edge pixels.
const DIFF_PIXEL_THRESHOLD = 0.1;
const MAX_DIFF_RATIO = 0.003; // 0.30%

/** Scenario table — kept in sync with ARCHITECTURE.md §11.2 as subsystems land. */
const SCENARIOS = [
  // Generation library: every procedural surface and mesh builder in one view.
  { name: 'gen_gallery', device: 'phoneLandscape', steps: 2, query: { scenario: 'gallery', quality: 'high' } },
  // World: silhouette and streaming from altitude, ground detail at eye height,
  // and the shoreline where terrain, water and fog meet.
  { name: 'terrain_wide', device: 'phoneLandscape', steps: 4, scenario: 'terrain_wide' },
  { name: 'terrain_ground', device: 'phoneLandscape', steps: 4, scenario: 'terrain_ground' },
  { name: 'terrain_coast', device: 'phoneLandscape', steps: 4, scenario: 'terrain_coast' },
  // POIs: exterior massing, interior materials and the vertical landmark.
  { name: 'poi_town', device: 'phoneLandscape', steps: 4, scenario: 'poi_town' },
  { name: 'poi_factory', device: 'phoneLandscape', steps: 4, scenario: 'poi_factory' },
  { name: 'poi_tower', device: 'phoneLandscape', steps: 4, scenario: 'poi_tower' },
  { name: 'poi_street', device: 'phoneLandscape', steps: 4, scenario: 'poi_street' },
  // Player: default third-person framing and the aim-down-sights rig.
  { name: 'player_tps', device: 'phoneLandscape', steps: 4, scenario: 'player_tps' },
  { name: 'player_ads', device: 'phoneLandscape', steps: 4, scenario: 'player_ads' },
  // Build system: every piece type on the shared grid, plus the ghost preview.
  { name: 'build_grid', device: 'phoneLandscape', steps: 4, scenario: 'build_grid' },
  // Combat feedback: muzzle flash, tracer, impact sparks, debris and a decal.
  { name: 'fx_combat', device: 'phoneLandscape', steps: 4, scenario: 'fx_combat' },
  // Touch control layout, in both orientations and in build mode.
  { name: 'touch_landscape', showUi: true, device: 'phoneLandscape', steps: 4, scenario: 'player_tps' },
  { name: 'touch_portrait', showUi: true, device: 'phone', steps: 4, scenario: 'player_tps' },
  { name: 'touch_build', showUi: true, device: 'phoneLandscape', steps: 4, scenario: 'player_tps',
    after: (page) => page.evaluate(() => {
      const t = window.__GAME.engine.services.get('touch');
      t.setBuildMode(true);
      t.setButtonVisible('interact', true);
      t.setActivePiece(2);
    }) },
];

async function capture(page, scn, file) {
  // Only plain data may cross into the page; `after` is a Node-side callback.
  const cfg = {
    scenario: scn.scenario || null, steps: scn.steps || 30, options: scn.options || {},
    // World and camera scenarios hide the control layer so a change to the 3D
    // render is not masked by, or confused with, a change to the HUD; the
    // touch_* scenarios are the ones that cover the controls themselves.
    showUi: !!scn.showUi,
  };
  await page.evaluate((s) => {
    window.__GAME.deterministic(true);
    // The gallery scene boots without the game's UI layer at all.
    if (window.__GAME.debug && window.__GAME.debug.setUiVisible) window.__GAME.debug.setUiVisible(s.showUi);
    if (s.scenario) window.__GAME.scenario(s.scenario, s.options || {});
  }, cfg);
  // Advance a fixed number of simulation steps, then settle the frame.
  await page.evaluate((s) => { window.__GAME.step(s.steps); }, cfg);
  if (scn.camera) await page.evaluate((c) => window.__GAME.setCamera(c), scn.camera);
  // Re-apply after stepping so streaming systems settle at the final pose.
  if (scn.scenario) await page.evaluate((s) => window.__GAME.scenario(s), scn.scenario);
  if (scn.after) await scn.after(page);
  await page.evaluate(() => { window.__GAME.renderOnly(2); });
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
}

function compare(name, actualPath, updateBaseline) {
  const basePath = path.join(BASELINE, `${name}.png`);
  if (!fs.existsSync(basePath) || updateBaseline) {
    fs.copyFileSync(actualPath, basePath);
    return { name, status: 'baseline-created', ratio: 0 };
  }
  const a = PNG.sync.read(fs.readFileSync(basePath));
  const b = PNG.sync.read(fs.readFileSync(actualPath));
  if (a.width !== b.width || a.height !== b.height) {
    return { name, status: 'size-mismatch', ratio: 1, detail: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: DIFF_PIXEL_THRESHOLD, includeAA: false,
  });
  const ratio = changed / (a.width * a.height);
  if (ratio > 0) fs.writeFileSync(path.join(OUT, `${name}.diff.png`), PNG.sync.write(diff));
  return { name, status: ratio <= MAX_DIFF_RATIO ? 'ok' : 'regression', ratio, changed };
}

async function run({ update = false, scenarios = SCENARIOS } = {}) {
  ensureDirs();
  const { server, port } = await startServer();
  const browser = await launch();
  const results = [];
  try {
    for (const scn of scenarios) {
      const { context, page, logs } = await openGame(browser, {
        device: scn.device, port, query: { seed: String(scn.seed || 1337), adaptive: '0', ...(scn.query || {}) },
      });
      const file = path.join(OUT, `${scn.name}.png`);
      try {
        await capture(page, scn, file);
      } catch (e) {
        results.push({ name: scn.name, status: 'error', ratio: 1, detail: e.message + '\n' + logs.join('\n') });
        await context.close();
        continue;
      }
      results.push(compare(scn.name, file, update));
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}

async function main() {
  const update = process.argv.includes('--update');
  const only = process.argv.find((a) => a.startsWith('--only='));
  let scenarios = SCENARIOS;
  if (only) {
    const names = only.slice(7).split(',');
    scenarios = SCENARIOS.filter((s) => names.includes(s.name));
  }
  console.log(`\n\x1b[1mVisual regression\x1b[0m (${scenarios.length} scenario(s)${update ? ', UPDATING BASELINES' : ''})`);
  const results = await run({ update, scenarios });
  let ok = true;
  for (const r of results) {
    const good = r.status === 'ok' || r.status === 'baseline-created';
    ok = check(`${r.name} — ${r.status}`, good, r.ratio !== undefined ? `diff=${fmt(r.ratio * 100, 4)}%` + (r.detail ? ` ${r.detail}` : '') : '') && ok;
  }
  if (require.main === module) process.exit(ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { run, SCENARIOS, compare, MAX_DIFF_RATIO };
