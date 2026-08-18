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

const BUDGET = {
  logic: { p50: 5.0, p95: 8.0, p99: 12.0 },
  sim: { p95: 4.0 },
  drawCalls: 150,
  triangles: 350000,
};

const RUNS = [
  { name: 'phone-landscape', device: 'phoneLandscape', seconds: 6 },
  { name: 'phone-portrait', device: 'phone', seconds: 4 },
];

async function measure(page, seconds) {
  // Warm-up: let shaders compile and the adaptive-resolution window settle.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
  await page.evaluate(() => window.__GAME.resetMetrics());
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), seconds * 1000);
  return page.evaluate(() => window.__GAME.metrics());
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
      const m = await measure(page, r.seconds);
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
    console.log(`\n  \x1b[1m${r.name}\x1b[0m  ${m.size.w}x${m.size.h} css @dpr ${fmt(m.pixelRatio, 2)}  (${m.samples} frames)`);
    console.log(`    logic  p50=${fmt(m.logicMs.p50)}ms p95=${fmt(m.logicMs.p95)}ms p99=${fmt(m.logicMs.p99)}ms`);
    console.log(`    sim    p50=${fmt(m.simMs.p50)}ms p95=${fmt(m.simMs.p95)}ms p99=${fmt(m.simMs.p99)}ms`);
    console.log(`    submit p50=${fmt(m.renderMs.p50)}ms p95=${fmt(m.renderMs.p95)}ms   [swiftshader-inflated]`);
    console.log(`    wall   p50=${fmt(m.frameMs.p50)}ms (${fmt(1000 / Math.max(0.001, m.frameMs.p50), 1)} fps sw-raster, informational)`);
    console.log(`    draw   calls=${m.drawCalls} tris=${m.triangles} programs=${m.programs}`);
    ok = check(`${r.name} logic p50 <= ${BUDGET.logic.p50}ms`, m.logicMs.p50 <= BUDGET.logic.p50, `got ${fmt(m.logicMs.p50)}`) && ok;
    ok = check(`${r.name} logic p95 <= ${BUDGET.logic.p95}ms`, m.logicMs.p95 <= BUDGET.logic.p95, `got ${fmt(m.logicMs.p95)}`) && ok;
    ok = check(`${r.name} logic p99 <= ${BUDGET.logic.p99}ms`, m.logicMs.p99 <= BUDGET.logic.p99, `got ${fmt(m.logicMs.p99)}`) && ok;
    ok = check(`${r.name} sim p95 <= ${BUDGET.sim.p95}ms`, m.simMs.p95 <= BUDGET.sim.p95, `got ${fmt(m.simMs.p95)}`) && ok;
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
