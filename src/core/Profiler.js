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
    this.count = 0;
    this.head = 0;
    this._spans = new Map();
    this._stack = [];
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
  endFrame(frameMs, cpu, sim, render, rendererInfo) {
    const i = this.head;
    this.frameMs[i] = frameMs;
    this.cpuMs[i] = cpu;
    this.simMs[i] = sim;
    this.renderMs[i] = render;
    this.logicMs[i] = Math.max(0, cpu - render);
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    if (rendererInfo) {
      this.drawCalls = rendererInfo.render.calls;
      this.triangles = rendererInfo.render.triangles;
      this.programs = rendererInfo.programs ? rendererInfo.programs.length : 0;
    }
  }

  reset() { this.count = 0; this.head = 0; for (const s of this._spans.values()) { s.ms = 0; } }

  summary() {
    // The ring buffer is unordered but percentiles do not care about order.
    const n = this.count;
    return {
      frameMs: percentiles(Array.from(this.frameMs), n),
      cpuMs: percentiles(Array.from(this.cpuMs), n),
      simMs: percentiles(Array.from(this.simMs), n),
      renderMs: percentiles(Array.from(this.renderMs), n),
      logicMs: percentiles(Array.from(this.logicMs), n),
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      programs: this.programs,
      samples: n,
    };
  }
}
