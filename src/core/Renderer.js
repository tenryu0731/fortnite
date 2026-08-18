import * as THREE from 'three';

/**
 * Renderer — WebGLRenderer wrapper owning resize and adaptive resolution.
 *
 * Adaptive resolution walks a ladder of pixel-ratio scales with hysteresis:
 * two consecutive slow windows step down, six consecutive fast windows step up.
 * That asymmetry stops the resolution from oscillating on a borderline device.
 */
const SCALE_LADDER = [1.0, 0.85, 0.72, 0.6, 0.5];

export class Renderer {
  constructor(canvas, settings) {
    this.settings = settings;
    this.canvas = canvas;
    this.three = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.q.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.three.setClearColor(0x87a7c8, 1);
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = 1.05;
    this.three.shadowMap.enabled = settings.q.shadows;
    this.three.shadowMap.type = THREE.PCFShadowMap;
    this.three.shadowMap.autoUpdate = true;
    this.three.info.autoReset = false;

    this.scaleIndex = 0;
    this.adaptive = settings.user.adaptiveResolution;
    this._slowWindows = 0;
    this._fastWindows = 0;
    this._acc = 0;
    this._accN = 0;
    this.width = 1;
    this.height = 1;
    this.resize();
  }

  get basePixelRatio() {
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    return Math.min(dpr, this.settings.q.maxPixelRatio);
  }

  get pixelRatio() { return this.basePixelRatio * SCALE_LADDER[this.scaleIndex]; }

  resize() {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth || window.innerWidth));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight || window.innerHeight));
    this.width = w; this.height = h;
    this.three.setPixelRatio(this.pixelRatio);
    this.three.setSize(w, h, false);
    return { w, h };
  }

  setScaleIndex(i) {
    const next = Math.min(SCALE_LADDER.length - 1, Math.max(0, i));
    if (next === this.scaleIndex) return false;
    this.scaleIndex = next;
    this.three.setPixelRatio(this.pixelRatio);
    this.three.setSize(this.width, this.height, false);
    return true;
  }

  /**
   * Feed one frame's cost. `budgetMs` is the target frame time (33.3ms for 30fps).
   * Evaluated in windows of 30 frames so a single hitch never changes resolution.
   */
  sampleFrame(frameMs, budgetMs = 33.3) {
    if (!this.adaptive) return;
    this._acc += frameMs; this._accN++;
    if (this._accN < 30) return;
    const avg = this._acc / this._accN;
    this._acc = 0; this._accN = 0;
    if (avg > budgetMs) {
      this._fastWindows = 0;
      if (++this._slowWindows >= 2) { this._slowWindows = 0; this.setScaleIndex(this.scaleIndex + 1); }
    } else if (avg < budgetMs * 0.6) {
      this._slowWindows = 0;
      if (++this._fastWindows >= 6) { this._fastWindows = 0; this.setScaleIndex(this.scaleIndex - 1); }
    } else {
      this._slowWindows = 0; this._fastWindows = 0;
    }
  }

  applyQuality() {
    this.three.shadowMap.enabled = this.settings.q.shadows;
    this.three.shadowMap.needsUpdate = true;
    this.three.setPixelRatio(this.pixelRatio);
    this.three.setSize(this.width, this.height, false);
  }

  render(scene, camera) {
    this.three.info.reset();
    this.three.render(scene, camera);
  }

  dispose() { this.three.dispose(); }
}
