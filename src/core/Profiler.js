/** Percentile helper over a plain numeric array (mutates a scratch copy). */
function percentiles(src, count) {
  if (count === 0) return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0, n: 0 };
  const a = src.slice(0, count).sort((x, y) => x - y);
  const at = (q) => a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), mean: sum / a.length, min: a[0], max: a[a.length - 1], n: a.length };
}

/**
 * Profiler — hierarchical span timing plus a ring buffer of per-frame costs.
 * The verification harness reads `summary()` directly, so the shape of that
 * object is part of the public contract described in ARCHITECTURE.md.
 */
export class Profiler {
  constructor(capacity = 1024) {
    this.capacity = capacity;
    this.frameMs = new Float32Array(capacity);
    this.cpuMs = new Float32Array(capacity);
    this.simMs = new Float32Array(capacity);
    this.renderMs = new Float32Array(capacity);
    // logicMs = sim + update + lateUpdate, i.e. everything except GPU command
    // submission. This is the device-portable CPU figure the gates use, since
    // the verification container rasterises in software.
    this.logicMs = new Float32Array(capacity);
    // Per-frame update/lateUpdate cost, and the cost of a *single* fixed step.
    // Splitting these matters: a frame runs one update but as many fixed steps
    // as the elapsed time demands, so a per-frame sim figure measures the host
    // machine's frame rate as much as the simulation. Only the per-step figure
    // transfers to a device that actually hits its frame rate.
    this.updateMs = new Float32Array(capacity);
    this.simStepMs = new Float32Array(capacity);
    this.count = 0;
    this.head = 0;
    this._spans = new Map();
    this._stack = [];
    // Per-system attribution, opt-in: the perf pass needs to know which system
    // owns a spike, and a p99 over the whole frame never says that.
    this.systemMs = new Map();
    this._t0 = 0;
    this.drawCalls = 0;
    this.triangles = 0;
    this.programs = 0;
    this.enabled = true;
  }

  now() { return performance.now(); }

  beginFrame() { this._t0 = this.now(); this._frameStart = this._t0; }

  begin(label) {
    if (!this.enabled) return;
    this._stack.push(label, this.now());
  }

  end(label) {
    if (!this.enabled) return;
    const t1 = this.now();
    const t0 = this._stack.pop();
    const l = this._stack.pop();
    if (l !== label) return; // mismatched span; ignore rather than throw in a hot loop
    let s = this._spans.get(label);
    if (!s) { s = { ms: 0, last: 0 }; this._spans.set(label, s); }
    s.last = t1 - t0;
    s.ms += s.last;
  }

  span(label) { const s = this._spans.get(label); return s ? s.last : 0; }

  /** Record one frame. `cpu` excludes the browser's own present/idle time. */
  endFrame(frameMs, cpu, sim, render, rendererInfo, simSteps = 1) {
    const i = this.head;
    this.frameMs[i] = frameMs;
    this.cpuMs[i] = cpu;
    this.simMs[i] = sim;
    this.renderMs[i] = render;
    this.logicMs[i] = Math.max(0, cpu - render);
    this.updateMs[i] = Math.max(0, cpu - render - sim);
    this.simStepMs[i] = simSteps > 0 ? sim / simSteps : 0;
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    if (rendererInfo) {
      this.drawCalls = rendererInfo.render.calls;
      this.triangles = rendererInfo.render.triangles;
      this.programs = rendererInfo.programs ? rendererInfo.programs.length : 0;
    }
  }

  /** Attribute `ms` to one system's phase. Called only while profiling is on. */
  addSystem(name, phase, ms) {
    const key = `${name}.${phase}`;
    let e = this.systemMs.get(key);
    if (!e) { e = { ms: 0, max: 0, calls: 0 }; this.systemMs.set(key, e); }
    e.ms += ms; e.calls++;
    if (ms > e.max) e.max = ms;
  }

  /** Systems sorted by total cost, heaviest first. */
  systemSummary(limit = 12) {
    const out = [];
    for (const [key, e] of this.systemMs) out.push({ key, ms: e.ms, max: e.max, calls: e.calls });
    out.sort((a, b) => b.ms - a.ms);
    return out.slice(0, limit);
  }

  reset() {
    this.count = 0; this.head = 0;
    for (const s of this._spans.values()) { s.ms = 0; }
    this.systemMs.clear();
  }

  summary() {
    // The ring buffer is unordered but percentiles do not care about order.
    const n = this.count;
    return {
      frameMs: percentiles(Array.from(this.frameMs), n),
      cpuMs: percentiles(Array.from(this.cpuMs), n),
      simMs: percentiles(Array.from(this.simMs), n),
      renderMs: percentiles(Array.from(this.renderMs), n),
      logicMs: percentiles(Array.from(this.logicMs), n),
      updateMs: percentiles(Array.from(this.updateMs), n),
      simStepMs: percentiles(Array.from(this.simStepMs), n),
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      programs: this.programs,
      samples: n,
    };
  }
}
