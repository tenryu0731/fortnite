import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Services } from './Services.js';
import { Profiler } from './Profiler.js';
import { Renderer } from './Renderer.js';

export const FIXED_DT = 1 / 60;
const MAX_FRAME_MS = 100;   // clamp so a background tab does not spiral the accumulator
const MAX_STEPS = 5;

/**
 * Engine — owns the scene, camera, render loop and subsystem registry.
 *
 * Systems implement any subset of:
 *   init(services)  fixedUpdate(dt)  update(dt, alpha)  lateUpdate(dt)  dispose()
 * and expose a numeric `order` used for a stable ascending sort.
 */
export class Engine {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.bus = new EventBus();
    this.services = new Services();
    this.profiler = new Profiler(600);
    this.renderer = new Renderer(canvas, settings);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.user.fov, 1, 0.15, 1200);
    this.camera.position.set(0, 40, 0);

    this.systems = [];
    this._byName = new Map();
    this.running = false;
    this.time = 0;          // simulated seconds since start
    this.frame = 0;
    this._acc = 0;
    this._last = 0;
    this._rafId = 0;

    // Deterministic mode: time advances by exact fixed steps under harness control.
    this.deterministic = false;
    this.timeScale = 1;
    this.paused = false;
    // `frozen` keeps the rAF loop alive (so the compositor still commits frames
    // for screenshots) while suppressing all simulation and animation advance.
    this.frozen = false;

    this.services.set('engine', this);
    this.services.set('bus', this.bus);
    this.services.set('settings', settings);
    this.services.set('scene', this.scene);
    this.services.set('camera', this.camera);
    this.services.set('renderer', this.renderer);
    this.services.set('profiler', this.profiler);

    this._onResize = () => this.resize();
    if (typeof window !== 'undefined') window.addEventListener('resize', this._onResize, { passive: true });
  }

  register(name, system) {
    system.name = name;
    if (system.order === undefined) system.order = this.systems.length * 10;
    this.systems.push(system);
    this._byName.set(name, system);
    this.services.set(name, system);
    return system;
  }

  system(name) { return this._byName.get(name); }

  async init() {
    this.systems.sort((a, b) => a.order - b.order);
    this._fixed = this.systems.filter((s) => s.fixedUpdate);
    this._update = this.systems.filter((s) => s.update);
    this._late = this.systems.filter((s) => s.lateUpdate);
    for (const s of this.systems) {
      if (s.init) await s.init(this.services);
    }
    // postInit runs after every system has initialised. Systems that must
    // observe the finished state of an earlier system (terrain meshing waits
    // for POI pads to flatten the height field) do their work here.
    for (const s of this.systems) {
      if (s.postInit) await s.postInit(this.services);
    }
    this.resize();
  }

  resize() {
    const { w, h } = this.renderer.resize();
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.bus.emit('engine:resize', { w, h });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      this._rafId = requestAnimationFrame(tick);
      this.frameStep(now);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  /** One real-time frame driven by rAF. */
  frameStep(now) {
    const wall = now - this._last;
    this._last = now;
    if (this.frozen) { this.renderer.render(this.scene, this.camera); return; }
    const dt = Math.min(wall, MAX_FRAME_MS) / 1000 * this.timeScale;
    this.advance(dt, wall);
  }

  /**
   * Advance simulation by `dt` seconds and render once.
   * Used by both the rAF loop and the deterministic harness stepper.
   */
  advance(dt, wallMs = dt * 1000) {
    const p = this.profiler;
    const tFrameStart = p.now();

    if (!this.paused) {
      this._acc += dt;
      let steps = 0;
      const tSim = p.now();
      while (this._acc >= FIXED_DT && steps < MAX_STEPS) {
        for (let i = 0; i < this._fixed.length; i++) this._fixed[i].fixedUpdate(FIXED_DT);
        this._acc -= FIXED_DT;
        this.time += FIXED_DT;
        steps++;
      }
      if (steps === MAX_STEPS) this._acc = 0; // give up on the backlog rather than stall
      this._simMs = p.now() - tSim;
    } else {
      this._simMs = 0;
    }

    const alpha = this._acc / FIXED_DT;
    for (let i = 0; i < this._update.length; i++) this._update[i].update(dt, alpha);
    for (let i = 0; i < this._late.length; i++) this._late[i].lateUpdate(dt, alpha);

    const tRender = p.now();
    this.renderer.render(this.scene, this.camera);
    const renderMs = p.now() - tRender;

    this.bus.flush();

    const cpuMs = p.now() - tFrameStart;
    p.endFrame(wallMs, cpuMs, this._simMs, renderMs, this.renderer.three.info);
    if (!this.deterministic) this.renderer.sampleFrame(wallMs);
    this.frame++;
  }

  /** Deterministic stepping for headless verification. */
  step(n = 1, dt = FIXED_DT) {
    for (let i = 0; i < n; i++) this.advance(dt, dt * 1000);
  }

  dispose() {
    this.stop();
    for (const s of this.systems) if (s.dispose) s.dispose();
    if (typeof window !== 'undefined') window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    this.bus.clear();
  }
}
