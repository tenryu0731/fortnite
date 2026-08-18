/** probe.cjs — ad-hoc: boot the game, dump state + a screenshot. */
const path = require('path');
const { startServer, launch, openGame, OUT } = require('./harness.cjs');
(async () => {
  const { server, port } = await startServer();
  const browser = await launch();
  const query = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); query[k] = v ?? '1'; }
  }
  try {
    const { context, page, logs } = await openGame(browser, { device: 'phoneLandscape', port, query });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const st = await page.evaluate(() => window.__GAME.state());
    const m = await page.evaluate(() => window.__GAME.metrics());
    console.log(JSON.stringify(st, null, 1));
    console.log('metrics:', JSON.stringify({ logic: m.logicMs, sim: m.simMs, calls: m.drawCalls, tris: m.triangles, wall: m.frameMs.p50 }));
    await page.screenshot({ path: path.join(OUT, 'probe.png') });
    const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
    if (errs.length) console.log('ERRORS:\n' + errs.join('\n'));
    await context.close();
  } catch (e) { console.error('FAILED:', e.message); }
  finally { await browser.close(); server.close(); }
})();
