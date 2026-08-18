/**
 * selftest.cjs — verifies the harness itself: page boot, the __GAME contract,
 * deterministic stepping, metric collection and synthetic touch delivery.
 * Runs first in run-all so a harness bug is never mistaken for a game bug.
 */
const { startServer, launch, openGame, check, fmt } = require('./harness.cjs');

async function main() {
  console.log('\n\x1b[1mHarness self-test\x1b[0m');
  const { server, port } = await startServer();
  const browser = await launch();
  let ok = true;
  try {
    const { context, page, logs } = await openGame(browser, { device: 'phoneLandscape', port });

    const api = await page.evaluate(() => Object.keys(window.__GAME));
    for (const k of ['engine', 'deterministic', 'step', 'stepSim', 'metrics', 'setCamera', 'state', 'input', 'renderOnly', 'resetMetrics']) {
      ok = check(`__GAME.${k} exists`, api.includes(k)) && ok;
    }

    // Deterministic stepping must advance the frame counter by exactly n.
    const stepped = await page.evaluate(() => {
      window.__GAME.deterministic(true);
      const a = window.__GAME.engine.frame;
      window.__GAME.step(10);
      return window.__GAME.engine.frame - a;
    });
    ok = check('step(10) advances exactly 10 frames', stepped === 10, `got ${stepped}`) && ok;

    // Frozen mode must not advance simulated time on its own.
    const drift = await page.evaluate(async () => {
      const t0 = window.__GAME.engine.time;
      await new Promise((r) => setTimeout(r, 400));
      return window.__GAME.engine.time - t0;
    });
    ok = check('frozen mode does not advance sim time', drift === 0, `drift=${drift}`) && ok;

    await page.evaluate(() => window.__GAME.deterministic(false));

    // WebGL context is real and rendering.
    const gl = await page.evaluate(() => {
      const r = window.__GAME.engine.renderer.three;
      return { ctx: !!r.getContext(), webgl2: r.capabilities.isWebGL2, maxTex: r.capabilities.maxTextureSize };
    });
    ok = check('WebGL2 context available', gl.ctx && gl.webgl2, `maxTexture=${gl.maxTex}`) && ok;

    // Synthetic touch must reach the page as pointer events.
    // Listeners are installed in an awaited evaluate so the tap cannot race the injection.
    await page.evaluate(() => {
      window.__seenPointer = [];
      const h = (e) => window.__seenPointer.push(e.type + ':' + e.pointerType);
      for (const t of ['pointerdown', 'pointermove', 'pointerup']) window.addEventListener(t, h, true);
    });
    await page.touchscreen.tap(200, 200);
    const seen = await page.evaluate(() => window.__seenPointer);
    ok = check('synthetic touch delivers pointer events', seen.length >= 2 && seen.some((s) => s.includes('touch')), seen.join(',')) && ok;

    // Multi-touch via CDP-free route: dispatchEvent of TouchEvent is used by
    // the touch suite, so confirm the page can construct one.
    const multi = await page.evaluate(() => {
      try {
        const t = new Touch({ identifier: 1, target: document.body, clientX: 10, clientY: 10 });
        const ev = new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true });
        return ev.touches.length === 1;
      } catch (e) { return 'error: ' + e.message; }
    });
    ok = check('TouchEvent construction supported (multi-touch synthesis)', multi === true, String(multi)) && ok;

    const m = await page.evaluate(() => window.__GAME.metrics());
    ok = check('metrics populated', m.samples > 0 && m.drawCalls > 0, `samples=${m.samples} calls=${m.drawCalls}`) && ok;

    const errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'));
    ok = check('no page errors', errors.length === 0, errors.join(' | ')) && ok;

    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
