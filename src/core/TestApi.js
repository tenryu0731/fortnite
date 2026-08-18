/**
 * TestApi — the `window.__GAME` surface used by the headless verification suite.
 * Documented in ARCHITECTURE.md §11.1; changing a field here means updating the
 * harness in tests/.
 */
export function installTestApi(engine, ctx) {
  const api = {
    version: 1,
    engine,
    ctx,
    ready: null,
    seed: ctx.seed,

    /** Freeze everything time-varying so screenshots are byte-comparable. */
    deterministic(on = true) {
      engine.deterministic = !!on;
      engine.frozen = !!on;
      engine.renderer.adaptive = !on && engine.settings.user.adaptiveResolution;
      if (on) engine.renderer.setScaleIndex(0);
      if (ctx.onDeterministic) ctx.onDeterministic(!!on);
      return true;
    },

    pause(on = true) { engine.paused = !!on; },
    timeScale(s) { engine.timeScale = s; },

    step(n = 1, dt) { engine.step(n, dt); return engine.frame; },

    /** Advance simulation without rendering — for logic tests. */
    stepSim(n = 1, dt) { engine.stepSim(n, dt); return engine.frame; },

    /** Render `n` frames without advancing simulation — for settling GPU state. */
    renderOnly(n = 1) {
      for (let i = 0; i < n; i++) engine.renderer.render(engine.scene, engine.camera);
      return n;
    },

    resetMetrics() { engine.profiler.reset(); },

    metrics() {
      const s = engine.profiler.summary();
      return {
        ...s,
        fps: s.frameMs.p50 > 0 ? 1000 / s.frameMs.p50 : 0,
        pixelRatio: engine.renderer.pixelRatio,
        scaleIndex: engine.renderer.scaleIndex,
        size: { w: engine.renderer.width, h: engine.renderer.height },
        frame: engine.frame,
      };
    },

    setCamera(pose) {
      const c = engine.camera;
      if (pose.position) c.position.set(pose.position[0], pose.position[1], pose.position[2]);
      if (pose.lookAt) c.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
      if (pose.fov) { c.fov = pose.fov; c.updateProjectionMatrix(); }
      c.updateMatrixWorld(true);
      return true;
    },

    scenario(name, opts) { return ctx.scenario ? ctx.scenario(name, opts) : false; },
    state() { return ctx.state ? ctx.state() : {}; },
    setSeed(n) { return ctx.setSeed ? ctx.setSeed(n) : false; },
    input: ctx.inputApi || {},
    debug: ctx.debug || {},
  };
  if (typeof window !== 'undefined') window.__GAME = api;
  return api;
}
