/**
 * perf.cjs — frame-time percentiles at mobile viewport/DPR.
 *
 * Gate rationale (ARCHITECTURE.md §11.3): the container has no GPU, so the
 * wall-clock frame time under SwiftShader is meaningless as an fps prediction.
 * The enforced budgets are therefore:
 *   - logicMs  (sim + update, excludes GPU command submission) — portable CPU cost
 *   - simMs    (fixed-step simulation only)
 *   - drawCalls / triangles — the GPU-side workload a phone would see
 * SwiftShader wall clock is printed for information but never gates.
 */
const { startServer, launch, openGame, check, fmt } = require('./harness.cjs');

/**
 * Budgets are stated per *unit of work*, not per host frame.
 *
 * A frame runs `update` once but as many fixed simulation steps as the elapsed
 * wall time demands. Under software rasterisation the host manages ~5fps, so
 * every frame drains a dozen steps and a per-frame sim figure would measure
 * SwiftShader rather than the simulation. `updateMs` (per frame) and
 * `simStepMs` (per fixed step) are both host-rate independent, so those are
 * what gate. `deviceFrame` recombines them into the CPU cost of one frame on
 * a device that is actually holding 30fps — two fixed steps plus one update —
 * which is the 8ms figure ARCHITECTURE.md 11.3 budgets for.
 */
const BUDGET = {
  update: { p50: 3.0, p95: 5.0, p99: 8.0 },
  simStep: { p50: 0.8, p95: 1.5, p99: 2.5 },
  deviceFrame: 8.0,
  drawCalls: 150,
  triangles: 350000,
  minSamples: 60,
};

const STEPS_PER_FRAME_AT_30FPS = 2;

/**
 * Software rasterisation runs at 1-3 fps here, so a wall-clock sample window
 * yields a handful of frames and a "p95" over five samples is noise. Every run
 * therefore shrinks the drawing buffer: fragment cost is the only thing that
 * changes, while the simulation, the update graph, the draw calls and the
 * triangle count stay exactly what a phone would see — and those are what the
 * budgets gate on. Full-resolution rendering is covered by the visual suite.
 */
const PERF_RASTER = 0.12;

const RUNS = [
  { name: 'phone-landscape', device: 'phoneLandscape', seconds: 14 },
  { name: 'phone-portrait', device: 'phone', seconds: 14 },
  // Worst case. The two runs above measure a quiet overlook, which is the
  // cheapest frame the game draws; this one stages a mid-match firefight (see
  // the perf_battle scenario) and holds the fire button down for the whole
  // sample, so the numbers reflect the frame a player actually fights in.
  { name: 'phone-landscape-battle', device: 'phoneLandscape', seconds: 14,
    query: { scenario: 'perf_battle' }, firing: true },
  { name: 'phone-portrait-battle', device: 'phone', seconds: 14,
    query: { scenario: 'perf_battle' }, firing: true },
];

async function measure(page, seconds, firing = false, raster = 1) {
  if (raster !== 1) await page.evaluate((s) => window.__GAME.setRasterScale(s), raster);
  // Warm-up: let shaders compile and the adaptive-resolution window settle.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
  // Hold fire and keep turning: a still camera lets the terrain LOD and the
  // vegetation packer sit idle, which hides exactly the costs worth gating.
  if (firing) {
    await page.evaluate(() => window.__GAME.input.override({
      fire: true, sprint: true, move: { x: 0, y: 1 }, look: { dx: 0.012, dy: 0 },
    }));
  }
  await page.evaluate(() => window.__GAME.resetMetrics());
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), seconds * 1000);
  const m = await page.evaluate(() => window.__GAME.metrics());
  if (firing) await page.evaluate(() => window.__GAME.input.clearOverride());
  return m;
}

async function run(runs = RUNS, query = {}) {
  const { server, port } = await startServer();
  const browser = await launch();
  const out = [];
  try {
    for (const r of runs) {
      const { context, page } = await openGame(browser, {
        device: r.device, port, query: { adaptive: '0', ...query, ...(r.query || {}) },
      });
      const m = await measure(page, r.seconds, r.firing, r.raster || PERF_RASTER);
      out.push({ ...r, metrics: m });
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  return out;
}

function report(results) {
  let ok = true;
  for (const r of results) {
    const m = r.metrics;
    const deviceFrame = m.updateMs.p95 + STEPS_PER_FRAME_AT_30FPS * m.simStepMs.p95;
    console.log(`\n  \x1b[1m${r.name}\x1b[0m  ${m.size.w}x${m.size.h} css @dpr ${fmt(m.pixelRatio, 2)}  (${m.samples} frames)`);
    console.log(`    update  p50=${fmt(m.updateMs.p50)}ms p95=${fmt(m.updateMs.p95)}ms p99=${fmt(m.updateMs.p99)}ms   [per frame]`);
    console.log(`    simstep p50=${fmt(m.simStepMs.p50)}ms p95=${fmt(m.simStepMs.p95)}ms p99=${fmt(m.simStepMs.p99)}ms   [per fixed step]`);
    console.log(`    device  ${fmt(deviceFrame)}ms CPU per frame at 30fps (${STEPS_PER_FRAME_AT_30FPS} steps + 1 update, p95)`);
    console.log(`    submit  p50=${fmt(m.renderMs.p50)}ms p95=${fmt(m.renderMs.p95)}ms   [swiftshader-inflated]`);
    console.log(`    wall    p50=${fmt(m.frameMs.p50)}ms (${fmt(1000 / Math.max(0.001, m.frameMs.p50), 1)} fps sw-raster, informational)`);
    console.log(`    draw    calls=${m.drawCalls} tris=${m.triangles} programs=${m.programs}`);
    if (m.rasterScale !== 1) console.log(`    raster  ${fmt(m.rasterScale, 2)}x drawing buffer (fragment cost only)`);
    ok = check(`${r.name} sampled >= ${BUDGET.minSamples} frames`, m.samples >= BUDGET.minSamples, `got ${m.samples}`) && ok;
    ok = check(`${r.name} update p50 <= ${BUDGET.update.p50}ms`, m.updateMs.p50 <= BUDGET.update.p50, `got ${fmt(m.updateMs.p50)}`) && ok;
    ok = check(`${r.name} update p95 <= ${BUDGET.update.p95}ms`, m.updateMs.p95 <= BUDGET.update.p95, `got ${fmt(m.updateMs.p95)}`) && ok;
    ok = check(`${r.name} update p99 <= ${BUDGET.update.p99}ms`, m.updateMs.p99 <= BUDGET.update.p99, `got ${fmt(m.updateMs.p99)}`) && ok;
    ok = check(`${r.name} sim step p95 <= ${BUDGET.simStep.p95}ms`, m.simStepMs.p95 <= BUDGET.simStep.p95, `got ${fmt(m.simStepMs.p95)}`) && ok;
    ok = check(`${r.name} sim step p99 <= ${BUDGET.simStep.p99}ms`, m.simStepMs.p99 <= BUDGET.simStep.p99, `got ${fmt(m.simStepMs.p99)}`) && ok;
    ok = check(`${r.name} device-frame CPU <= ${BUDGET.deviceFrame}ms`, deviceFrame <= BUDGET.deviceFrame, `got ${fmt(deviceFrame)}`) && ok;
    ok = check(`${r.name} draw calls <= ${BUDGET.drawCalls}`, m.drawCalls <= BUDGET.drawCalls, `got ${m.drawCalls}`) && ok;
    ok = check(`${r.name} triangles <= ${BUDGET.triangles}`, m.triangles <= BUDGET.triangles, `got ${m.triangles}`) && ok;
  }
  return ok;
}

async function main() {
  console.log(`\n\x1b[1mPerformance\x1b[0m (headless chromium, SwiftShader — CPU + draw budgets gate)`);
  const results = await run();
  const ok = report(results);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { run, report, BUDGET, RUNS };
